import { Router } from "express";
import { z } from "zod";
import { query } from "../db/index.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { currentUser, requireRole } from "../middleware/auth.js";
import { isUuid } from "../middleware/error.js";
import { param, queryParams } from "../middleware/validate.js";
import { similarityRange } from "../services/ai/embeddings.js";
import { APPLICATION_FROM, APPLICATION_SELECT, changeApplicationStatus } from "../services/applications.service.js";
import { JOB_SELECT } from "../services/jobs.service.js";
import { computeMatch } from "../services/matching.js";

const router = Router();
router.use(requireRole("seeker"));

router.get("/applications", async (req, res) => {
  const { rows } = await query(
    `SELECT ${APPLICATION_SELECT}, j.location AS "jobLocation", j.work_mode AS "jobWorkMode",
       (SELECT json_agg(json_build_object('scheduledAt', i.scheduled_at, 'mode', i.mode, 'status', i.status, 'durationMinutes', i.duration_minutes)
               ORDER BY i.scheduled_at)
        FROM interviews i WHERE i.application_id = a.id AND i.status <> 'cancelled') AS interviews
     ${APPLICATION_FROM} WHERE a.seeker_id = $1 ORDER BY a.created_at DESC`,
    [currentUser(req).id],
  );
  res.json({ applications: rows });
});

router.post("/applications/:id/withdraw", async (req, res) => {
  const me = currentUser(req);
  const id = param(req, "id");
  if (!isUuid(id)) throw notFound("Application");
  const { rows } = await query<{ seekerId: string; status: string }>(
    `SELECT seeker_id AS "seekerId", status FROM applications WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound("Application");
  if (rows[0].seekerId !== me.id) throw forbidden();
  if (["selected", "rejected", "withdrawn"].includes(rows[0].status)) throw badRequest("This application is already closed");
  const status = await changeApplicationStatus(me.id, id, "withdrawn", "Withdrawn by candidate");
  res.json({ status });
});

/**
 * AI job recommendations: nearest open jobs to the seeker's primary resume embedding
 * (pgvector cosine distance), re-ranked with required-skill coverage.
 */
router.get("/recommendations", async (req, res) => {
  const me = currentUser(req);
  const { limit } = queryParams(req, z.object({ limit: z.coerce.number().int().min(1).max(30).default(10) }));
  const resume = (
    await query<{ id: string; skills: string[]; hasEmbedding: boolean }>(
      `SELECT id, skills, embedding IS NOT NULL AS "hasEmbedding" FROM resumes WHERE user_id = $1
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
      [me.id],
    )
  ).rows[0];
  if (!resume) {
    res.json({ resumeId: null, recommendations: [], message: "Upload a resume to get personalised job recommendations." });
    return;
  }

  const { floor, ceil } = similarityRange();
  // Pull a wider candidate set by vector similarity, then re-rank in JS with skills.
  const { rows } = await query<Record<string, unknown> & { skills: string[]; similarity: number | null }>(
    `SELECT ${JOB_SELECT},
       ${resume.hasEmbedding ? "1 - (j.embedding <=> r.embedding)" : "NULL::float8"} AS similarity
     FROM jobs j JOIN companies c ON c.id = j.company_id, resumes r
     WHERE r.id = $1 AND j.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.seeker_id = $2)
     ORDER BY ${resume.hasEmbedding ? "j.embedding <=> r.embedding" : "cardinality(ARRAY(SELECT unnest(j.skills) INTERSECT SELECT unnest(r.skills))) DESC"}
     LIMIT $3`,
    [resume.id, me.id, limit * 4],
  );

  const recommendations = rows
    .map((job) => {
      const m = computeMatch({ candidateSkills: resume.skills, jobSkills: job.skills, similarity: job.similarity });
      const reasons: string[] = [];
      if (m.matched.length) reasons.push(`You have ${m.matched.length} of ${job.skills.length} required skills: ${m.matched.slice(0, 4).join(", ")}`);
      if (m.semantic >= 0.5) reasons.push("Your experience closely matches the role description");
      if (m.missing.length) reasons.push(`Skills to highlight or build: ${m.missing.slice(0, 3).join(", ")}`);
      return { job, matchScore: m.score, matchedSkills: m.matched, missingSkills: m.missing, reasons };
    })
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, limit);

  res.json({ resumeId: resume.id, recommendations, similarityRange: { floor, ceil } });
});

export default router;
