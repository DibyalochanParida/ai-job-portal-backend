/**
 * Recomputes every job and resume embedding with the currently configured provider.
 * Run after switching EMBEDDINGS_PROVIDER or VOYAGE_MODEL: vectors from different models
 * are not comparable, so mixing them would make search and matching meaningless.
 */
import { closeDb, connectDb, toVector } from "./index.js";
import { logger } from "../logger.js";
import { embed, embeddingModelName } from "../services/ai/embeddings.js";
import { jobEmbeddingText } from "../services/jobs.service.js";
import { resumeEmbeddingText, type ParsedResume } from "../services/ai/resumeParser.js";
import type { JobInput } from "../services/jobs.service.js";

const db = await connectDb();
try {
  const jobs = (
    await db.query<JobInput & { id: string }>(
      `SELECT id, title, description, requirements, skills, location, work_mode AS "workMode", experience_level AS "experienceLevel" FROM jobs`,
    )
  ).rows;
  const jobVecs = await embed(jobs.map((j) => jobEmbeddingText(j)), "document");
  for (const [i, j] of jobs.entries()) await db.query("UPDATE jobs SET embedding = $2::vector WHERE id = $1", [j.id, toVector(jobVecs[i])]);

  const resumes = (await db.query<{ id: string; parsed: ParsedResume; raw_text: string }>("SELECT id, parsed, raw_text FROM resumes")).rows;
  const resVecs = await embed(resumes.map((r) => resumeEmbeddingText(r.parsed, r.raw_text)), "document");
  for (const [i, r] of resumes.entries()) await db.query("UPDATE resumes SET embedding = $2::vector WHERE id = $1", [r.id, toVector(resVecs[i])]);

  logger.info({ model: embeddingModelName(), jobs: jobs.length, resumes: resumes.length }, "Re-embedded jobs and resumes");
} finally {
  await closeDb();
}
