import { Router } from "express";
import { z } from "zod";
import { query } from "../db/index.js";
import { forbidden, notFound } from "../lib/errors.js";
import { currentUser, optionalAuth, requireRole } from "../middleware/auth.js";
import { isUuid } from "../middleware/error.js";
import { aiLimiter } from "../middleware/rateLimit.js";
import { body, param, queryParams } from "../middleware/validate.js";
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, parseSearchQuery, WORK_MODES } from "../services/ai/querySearch.js";
import { applyToJob, getCompanyIdForUser } from "../services/applications.service.js";
import { createJob, getJob, JobInputSchema, searchJobs, updateJob } from "../services/jobs.service.js";

const router = Router();

const ListQuery = z.object({
  q: z.string().trim().max(300).optional(),
  skills: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [])),
  location: z.string().trim().max(140).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  experienceLevel: z.enum(EXPERIENCE_LEVELS).optional(),
  salaryMin: z.coerce.number().int().nonnegative().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Browse/filter open jobs (public). `q` is matched with hybrid full-text + semantic search. */
router.get("/", async (req, res) => {
  const p = queryParams(req, ListQuery);
  const { total, results } = await searchJobs({
    text: p.q,
    skills: p.skills,
    location: p.location,
    workMode: p.workMode,
    employmentType: p.employmentType,
    experienceLevel: p.experienceLevel,
    salaryMin: p.salaryMin,
    limit: p.limit,
    offset: (p.page - 1) * p.limit,
  });
  res.json({ total, page: p.page, limit: p.limit, results });
});

const NlSearchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(50).default(20),
});

/** Natural-language search: "remote senior react jobs paying over 150k". */
router.post("/search", optionalAuth, aiLimiter, async (req, res) => {
  const input = body(req, NlSearchSchema);
  const { intent, source } = await parseSearchQuery(input.query);
  const { total, results } = await searchJobs({
    text: intent.semanticQuery,
    semanticQuery: intent.semanticQuery,
    skills: intent.skills,
    location: intent.location,
    workMode: intent.workMode,
    employmentType: intent.employmentType,
    experienceLevel: intent.experienceLevel,
    salaryMin: intent.salaryMin,
    limit: input.limit,
    offset: (input.page - 1) * input.limit,
  });
  res.json({ query: input.query, interpretation: intent, source, total, page: input.page, limit: input.limit, results });
});

router.get("/:id", optionalAuth, async (req, res) => {
  const id = param(req, "id");
  if (!isUuid(id)) throw notFound("Job");
  const job = await getJob(id);
  if (!job) throw notFound("Job");
  // Drafts/closed jobs are only visible to their owner.
  if (job.status !== "open") {
    const owner = (await query<{ owner_id: string }>("SELECT owner_id FROM companies WHERE id = $1", [job.companyId])).rows[0];
    if (req.user?.id !== owner?.owner_id && job.status === "draft") throw notFound("Job");
  }
  let application: unknown = null;
  if (req.user?.role === "seeker") {
    application =
      (
        await query(
          `SELECT id, status, match_score AS "matchScore", created_at AS "createdAt" FROM applications WHERE job_id = $1 AND seeker_id = $2`,
          [id, req.user.id],
        )
      ).rows[0] ?? null;
  }
  res.json({ job, application });
});

router.post("/", requireRole("employer"), async (req, res) => {
  const me = currentUser(req);
  const input = body(req, JobInputSchema);
  const companyId = await getCompanyIdForUser(me.id);
  const job = await createJob(companyId, me.id, input);
  res.status(201).json({ job });
});

async function assertOwnsJob(userId: string, jobId: string) {
  if (!isUuid(jobId)) throw notFound("Job");
  const { rows } = await query<{ owner: string }>(
    "SELECT c.owner_id AS owner FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = $1",
    [jobId],
  );
  if (!rows[0]) throw notFound("Job");
  if (rows[0].owner !== userId) throw forbidden();
}

router.put("/:id", requireRole("employer"), async (req, res) => {
  const id = param(req, "id");
  await assertOwnsJob(currentUser(req).id, id);
  const job = await updateJob(id, body(req, JobInputSchema));
  res.json({ job });
});

router.patch("/:id/status", requireRole("employer"), async (req, res) => {
  const id = param(req, "id");
  await assertOwnsJob(currentUser(req).id, id);
  const { status } = body(req, z.object({ status: z.enum(["draft", "open", "closed"]) }));
  await query("UPDATE jobs SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
  res.json({ job: await getJob(id) });
});

router.delete("/:id", requireRole("employer"), async (req, res) => {
  const id = param(req, "id");
  await assertOwnsJob(currentUser(req).id, id);
  await query("DELETE FROM jobs WHERE id = $1", [id]);
  res.status(204).end();
});

const ApplySchema = z.object({
  resumeId: z.uuid().nullable().optional(),
  coverLetter: z.string().trim().max(5000).nullable().optional(),
});

router.post("/:id/apply", requireRole("seeker"), async (req, res) => {
  const id = param(req, "id");
  if (!isUuid(id)) throw notFound("Job");
  const result = await applyToJob(currentUser(req).id, id, body(req, ApplySchema));
  res.status(201).json({ application: result });
});

export default router;
