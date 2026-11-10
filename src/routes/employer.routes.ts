import { Router } from "express";
import { z } from "zod";
import { getDb, query, SqlParams } from "../db/index.js";
import { badRequest, notFound } from "../lib/errors.js";
import { currentUser, requireRole } from "../middleware/auth.js";
import { isUuid } from "../middleware/error.js";
import { aiLimiter } from "../middleware/rateLimit.js";
import { body, param, queryParams } from "../middleware/validate.js";
import { askAssistant } from "../services/ai/assistant.js";
import { getEmployerAnalytics, jobsOverview } from "../services/analytics.service.js";
import {
  APPLICATION_FROM,
  APPLICATION_SELECT,
  APPLICATION_STATUSES,
  assertEmployerOwnsApplication,
  changeApplicationStatus,
  getCompanyIdForUser,
  stageIndex,
} from "../services/applications.service.js";
import { storage } from "../services/storage/index.js";

const router = Router();
router.use(requireRole("employer"));

async function companyFor(req: Parameters<typeof currentUser>[0]) {
  return getCompanyIdForUser(currentUser(req).id);
}

router.get("/jobs", async (req, res) => {
  res.json({ jobs: await jobsOverview(await companyFor(req)) });
});

const CandidatesQuery = z.object({
  jobId: z.uuid().optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["match", "recent"]).default("match"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** All applicants across the company's jobs, filterable by job and stage. */
router.get("/candidates", async (req, res) => {
  const companyId = await companyFor(req);
  const f = queryParams(req, CandidatesQuery);
  const p = new SqlParams();
  const where = [`j.company_id = ${p.add(companyId)}`];
  if (f.jobId) where.push(`a.job_id = ${p.add(f.jobId)}`);
  if (f.status) where.push(`a.status = ${p.add(f.status)}`);
  if (f.q) where.push(`(u.full_name ILIKE ${p.add(`%${f.q}%`)} OR r.parsed->>'headline' ILIKE ${p.add(`%${f.q}%`)})`);
  const order = f.sort === "match" ? "a.match_score DESC NULLS LAST, a.created_at DESC" : "a.created_at DESC";
  const { rows } = await query<Record<string, unknown> & { total: number }>(
    `SELECT ${APPLICATION_SELECT}, count(*) OVER()::int AS total ${APPLICATION_FROM}
     WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${p.add(f.limit)} OFFSET ${p.add((f.page - 1) * f.limit)}`,
    p.values,
  );
  res.json({ total: rows[0]?.total ?? 0, candidates: rows.map(({ total: _t, ...r }) => r) });
});

router.get("/applications/:id", async (req, res) => {
  const id = param(req, "id");
  if (!isUuid(id)) throw notFound("Application");
  await assertEmployerOwnsApplication(currentUser(req).id, id);
  const [app, events, interviews] = await Promise.all([
    query(`SELECT ${APPLICATION_SELECT}, r.parsed AS "resumeParsed", j.skills AS "jobSkills" ${APPLICATION_FROM} WHERE a.id = $1`, [id]),
    query(
      `SELECT e.from_status AS "fromStatus", e.to_status AS "toStatus", e.note, e.created_at AS "createdAt", u.full_name AS "changedBy"
       FROM application_events e LEFT JOIN users u ON u.id = e.changed_by WHERE e.application_id = $1 ORDER BY e.created_at`,
      [id],
    ),
    query(
      `SELECT id, scheduled_at AS "scheduledAt", duration_minutes AS "durationMinutes", mode, interviewer, status, rating, feedback
       FROM interviews WHERE application_id = $1 ORDER BY scheduled_at`,
      [id],
    ),
  ]);
  res.json({ application: app.rows[0], events: events.rows, interviews: interviews.rows });
});

router.patch("/applications/:id/status", async (req, res) => {
  const me = currentUser(req);
  const id = param(req, "id");
  if (!isUuid(id)) throw notFound("Application");
  const input = body(
    req,
    z.object({ status: z.enum(APPLICATION_STATUSES).exclude(["withdrawn"]), note: z.string().trim().max(1000).optional() }),
  );
  await assertEmployerOwnsApplication(me.id, id);
  const status = await changeApplicationStatus(me.id, id, input.status, input.note);
  res.json({ status });
});

router.get("/applications/:id/resume", async (req, res) => {
  const id = param(req, "id");
  if (!isUuid(id)) throw notFound("Application");
  const app = await assertEmployerOwnsApplication(currentUser(req).id, id);
  if (!app.resumeId) throw notFound("Resume");
  const r = (
    await query<{ fileKey: string; fileName: string }>(`SELECT file_key AS "fileKey", file_name AS "fileName" FROM resumes WHERE id = $1`, [app.resumeId])
  ).rows[0];
  if (!r) throw notFound("Resume");
  res.json({ url: await storage().getDownloadUrl(r.fileKey, r.fileName) });
});

// ------------------------------------------------------------------ interviews

const ScheduleSchema = z.object({
  scheduledAt: z.coerce.date(),
  durationMinutes: z.number().int().min(5).max(480).default(45),
  mode: z.enum(["video", "phone", "onsite"]).default("video"),
  interviewer: z.string().trim().max(120).nullable().optional(),
});

router.post("/applications/:id/interviews", async (req, res) => {
  const me = currentUser(req);
  const id = param(req, "id");
  if (!isUuid(id)) throw notFound("Application");
  const input = body(req, ScheduleSchema);
  const app = await assertEmployerOwnsApplication(me.id, id);
  if (["rejected", "withdrawn"].includes(app.status)) throw badRequest("Cannot schedule an interview for a closed application");

  const interview = await getDb().transaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO interviews (application_id, scheduled_at, duration_minutes, mode, interviewer) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, scheduled_at AS "scheduledAt", duration_minutes AS "durationMinutes", mode, interviewer, status`,
      [id, input.scheduledAt, input.durationMinutes, input.mode, input.interviewer ?? null],
    );
    if (stageIndex(app.status) < stageIndex("scheduled")) {
      await changeApplicationStatus(me.id, id, "scheduled", "Interview scheduled", tx);
    }
    return rows[0];
  });
  res.status(201).json({ interview });
});

router.get("/interviews", async (req, res) => {
  const companyId = await companyFor(req);
  const { scope } = queryParams(req, z.object({ scope: z.enum(["upcoming", "past", "all"]).default("upcoming") }));
  const cond = scope === "upcoming" ? "AND i.scheduled_at >= now() - interval '1 hour'" : scope === "past" ? "AND i.scheduled_at < now()" : "";
  const { rows } = await query(
    `SELECT i.id, i.scheduled_at AS "scheduledAt", i.duration_minutes AS "durationMinutes", i.mode, i.interviewer, i.status,
            i.rating, i.feedback, a.id AS "applicationId", a.status AS "applicationStatus", u.full_name AS "candidateName",
            j.title AS "jobTitle", a.match_score AS "matchScore"
     FROM interviews i JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.seeker_id
     WHERE j.company_id = $1 ${cond}
     ORDER BY i.scheduled_at ${scope === "past" ? "DESC" : "ASC"} LIMIT 200`,
    [companyId],
  );
  res.json({ interviews: rows });
});

const UpdateInterviewSchema = z.object({
  status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
  scheduledAt: z.coerce.date().optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  feedback: z.string().trim().max(5000).nullable().optional(),
});

router.patch("/interviews/:id", async (req, res) => {
  const me = currentUser(req);
  const id = param(req, "id");
  if (!isUuid(id)) throw notFound("Interview");
  const input = body(req, UpdateInterviewSchema);
  const owned = (
    await query<{ applicationId: string }>(
      `SELECT i.application_id AS "applicationId" FROM interviews i JOIN applications a ON a.id = i.application_id
       JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id WHERE i.id = $1 AND c.owner_id = $2`,
      [id, me.id],
    )
  ).rows[0];
  if (!owned) throw notFound("Interview");

  const interview = await getDb().transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE interviews SET
         status = coalesce($2, status), scheduled_at = coalesce($3, scheduled_at), duration_minutes = coalesce($4, duration_minutes),
         rating = CASE WHEN $5::boolean THEN $6 ELSE rating END, feedback = CASE WHEN $7::boolean THEN $8 ELSE feedback END,
         updated_at = now()
       WHERE id = $1
       RETURNING id, scheduled_at AS "scheduledAt", duration_minutes AS "durationMinutes", mode, interviewer, status, rating, feedback`,
      [
        id, input.status ?? null, input.scheduledAt ?? null, input.durationMinutes ?? null,
        input.rating !== undefined, input.rating ?? null, input.feedback !== undefined, input.feedback ?? null,
      ],
    );
    if (input.status === "completed") {
      const app = (await tx.query<{ status: string }>("SELECT status FROM applications WHERE id = $1", [owned.applicationId])).rows[0];
      if (app && stageIndex(app.status) >= 0 && stageIndex(app.status) < stageIndex("interviewed")) {
        await changeApplicationStatus(me.id, owned.applicationId, "interviewed", "Interview completed", tx);
      }
    }
    return rows[0];
  });
  res.json({ interview });
});

// ------------------------------------------------------------------ analytics + assistant

router.get("/analytics", async (req, res) => {
  const { days } = queryParams(req, z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }));
  res.json(await getEmployerAnalytics(await companyFor(req), days));
});

const AssistantSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(20)
    .default([]),
});

router.post("/assistant", aiLimiter, async (req, res) => {
  const me = currentUser(req);
  const input = body(req, AssistantSchema);
  const company = (await query<{ id: string; name: string }>("SELECT id, name FROM companies WHERE owner_id = $1", [me.id])).rows[0];
  if (!company) throw notFound("Company");
  const result = await askAssistant({ companyId: company.id, companyName: company.name, message: input.message, history: input.history });
  res.json(result);
});

export default router;
