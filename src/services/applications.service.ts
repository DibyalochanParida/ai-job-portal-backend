import { getDb, query, type Queryable } from "../db/index.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { computeMatch } from "./matching.js";

export const APPLICATION_STATUSES = [
  "applied",
  "shortlisted",
  "scheduled",
  "interviewed",
  "recommended",
  "selected",
  "rejected",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Forward pipeline stages, in order. rejected/withdrawn are terminal "dropped" states. */
export const PIPELINE_STAGES = ["applied", "shortlisted", "scheduled", "interviewed", "recommended", "selected"] as const;
export const DROPPED_STATUSES = ["rejected", "withdrawn"] as const;

export const stageIndex = (s: string) => PIPELINE_STAGES.indexOf(s as (typeof PIPELINE_STAGES)[number]);

export async function getCompanyIdForUser(userId: string, db: Queryable = getDb()): Promise<string> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM companies WHERE owner_id = $1", [userId]);
  if (!rows[0]) throw forbidden("No company profile found for this employer account");
  return rows[0].id;
}

/** Throws unless the application belongs to a job of the employer's company. */
export async function assertEmployerOwnsApplication(userId: string, applicationId: string) {
  const { rows } = await query<{ status: ApplicationStatus; companyOwner: string; resumeId: string | null }>(
    `SELECT a.status, c.owner_id AS "companyOwner", a.resume_id AS "resumeId"
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
     WHERE a.id = $1`,
    [applicationId],
  );
  const app = rows[0];
  if (!app) throw notFound("Application");
  if (app.companyOwner !== userId) throw forbidden();
  return app;
}

export async function recordStatusChange(
  db: Queryable,
  applicationId: string,
  from: string | null,
  to: string,
  changedBy: string | null,
  note?: string | null,
) {
  await db.query(
    `INSERT INTO application_events (application_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
    [applicationId, from, to, changedBy, note ?? null],
  );
}

export async function applyToJob(seekerId: string, jobId: string, input: { resumeId?: string | null; coverLetter?: string | null }) {
  const job = (
    await query<{ status: string; skills: string[] }>("SELECT status, skills FROM jobs WHERE id = $1", [jobId])
  ).rows[0];
  if (!job) throw notFound("Job");
  if (job.status !== "open") throw badRequest("This job is no longer accepting applications");

  const resume = (
    await query<{ id: string; skills: string[] }>(
      input.resumeId
        ? "SELECT id, skills FROM resumes WHERE id = $1 AND user_id = $2"
        : "SELECT id, skills FROM resumes WHERE user_id = $1 ORDER BY is_primary DESC, created_at DESC LIMIT 1",
      input.resumeId ? [input.resumeId, seekerId] : [seekerId],
    )
  ).rows[0];
  if (input.resumeId && !resume) throw badRequest("Resume not found");
  if (!resume) throw badRequest("Upload a resume before applying");

  const sim = (
    await query<{ similarity: number | null }>(
      `SELECT 1 - (r.embedding <=> j.embedding) AS similarity FROM resumes r, jobs j WHERE r.id = $1 AND j.id = $2`,
      [resume.id, jobId],
    )
  ).rows[0]?.similarity ?? null;
  const match = computeMatch({ candidateSkills: resume.skills, jobSkills: job.skills, similarity: sim });

  return getDb().transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO applications (job_id, seeker_id, resume_id, cover_letter, match_score, matched_skills, missing_skills)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [jobId, seekerId, resume.id, input.coverLetter ?? null, match.score, match.matched, match.missing],
    );
    const id = rows[0]!.id;
    await recordStatusChange(tx, id, null, "applied", seekerId);
    return { id, matchScore: match.score, matchedSkills: match.matched, missingSkills: match.missing };
  });
}

export async function changeApplicationStatus(
  actorId: string,
  applicationId: string,
  to: ApplicationStatus,
  note?: string | null,
  db?: Queryable,
) {
  const run = async (tx: Queryable) => {
    const { rows } = await tx.query<{ status: ApplicationStatus }>(
      "SELECT status FROM applications WHERE id = $1 FOR UPDATE",
      [applicationId],
    );
    const from = rows[0]?.status;
    if (!from) throw notFound("Application");
    if (from === to) return from;
    if (from === "withdrawn") throw badRequest("The candidate withdrew this application");
    await tx.query("UPDATE applications SET status = $2, updated_at = now() WHERE id = $1", [applicationId, to]);
    await recordStatusChange(tx, applicationId, from, to, actorId, note);
    return to;
  };
  return db ? run(db) : getDb().transaction(run);
}

export const APPLICATION_SELECT = `
  a.id, a.status, a.match_score AS "matchScore", a.matched_skills AS "matchedSkills", a.missing_skills AS "missingSkills",
  a.cover_letter AS "coverLetter", a.created_at AS "createdAt", a.updated_at AS "updatedAt",
  a.job_id AS "jobId", j.title AS "jobTitle", c.name AS "companyName",
  a.seeker_id AS "seekerId", u.full_name AS "candidateName", u.email AS "candidateEmail",
  a.resume_id AS "resumeId", r.parsed->>'headline' AS "candidateHeadline",
  (r.parsed->>'totalYearsExperience')::float8 AS "candidateYears"`;

export const APPLICATION_FROM = `
  FROM applications a
  JOIN jobs j ON j.id = a.job_id
  JOIN companies c ON c.id = j.company_id
  JOIN users u ON u.id = a.seeker_id
  LEFT JOIN resumes r ON r.id = a.resume_id`;
