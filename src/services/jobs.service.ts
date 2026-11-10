import { z } from "zod";
import { query, SqlParams, toVector, type Queryable, getDb } from "../db/index.js";
import { normalizeSkills } from "../lib/skills.js";
import { embedOne, similarityRange } from "./ai/embeddings.js";
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, WORK_MODES } from "./ai/querySearch.js";

export const JobInputSchema = z
  .object({
    title: z.string().trim().min(3).max(140),
    description: z.string().trim().min(20).max(20_000),
    requirements: z.string().trim().max(10_000).default(""),
    skills: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
    location: z.string().trim().max(140).default(""),
    workMode: z.enum(WORK_MODES).default("onsite"),
    employmentType: z.enum(EMPLOYMENT_TYPES).default("full_time"),
    experienceLevel: z.enum(EXPERIENCE_LEVELS).default("mid"),
    salaryMin: z.number().int().nonnegative().nullable().optional(),
    salaryMax: z.number().int().nonnegative().nullable().optional(),
    currency: z.string().trim().length(3).toUpperCase().default("USD"),
    status: z.enum(["draft", "open", "closed"]).default("open"),
  })
  .refine((j) => j.salaryMin == null || j.salaryMax == null || j.salaryMin <= j.salaryMax, {
    message: "salaryMin must be less than or equal to salaryMax",
    path: ["salaryMin"],
  });

export type JobInput = z.infer<typeof JobInputSchema>;

export const JOB_SELECT = `
  j.id, j.title, j.description, j.requirements, j.skills, j.location,
  j.work_mode AS "workMode", j.employment_type AS "employmentType", j.experience_level AS "experienceLevel",
  j.salary_min AS "salaryMin", j.salary_max AS "salaryMax", j.currency, j.status,
  j.company_id AS "companyId", c.name AS "companyName", c.industry AS "companyIndustry",
  j.created_at AS "createdAt", j.updated_at AS "updatedAt"`;

export interface JobRow {
  id: string;
  title: string;
  description: string;
  requirements: string;
  skills: string[];
  location: string;
  workMode: string;
  employmentType: string;
  experienceLevel: string;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string;
  status: string;
  companyId: string;
  companyName: string;
  createdAt: Date;
  updatedAt: Date;
}

export function jobEmbeddingText(job: Pick<JobInput, "title" | "description" | "requirements" | "skills" | "experienceLevel" | "location" | "workMode">): string {
  return [
    `${job.title} (${job.experienceLevel} level, ${job.workMode}${job.location ? `, ${job.location}` : ""})`,
    `Skills: ${job.skills.join(", ")}`,
    job.description,
    job.requirements,
  ].join("\n");
}

export async function createJob(companyId: string, userId: string, input: JobInput, db: Queryable = getDb()) {
  const skills = normalizeSkills(input.skills);
  const embedding = await embedOne(jobEmbeddingText({ ...input, skills }), "document");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO jobs (company_id, posted_by, title, description, requirements, skills, location, work_mode,
       employment_type, experience_level, salary_min, salary_max, currency, status, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector) RETURNING id`,
    [
      companyId, userId, input.title, input.description, input.requirements, skills, input.location, input.workMode,
      input.employmentType, input.experienceLevel, input.salaryMin ?? null, input.salaryMax ?? null, input.currency,
      input.status, toVector(embedding),
    ],
  );
  return getJob(rows[0]!.id, db);
}

export async function updateJob(jobId: string, input: JobInput) {
  const skills = normalizeSkills(input.skills);
  const embedding = await embedOne(jobEmbeddingText({ ...input, skills }), "document");
  await query(
    `UPDATE jobs SET title=$2, description=$3, requirements=$4, skills=$5, location=$6, work_mode=$7, employment_type=$8,
       experience_level=$9, salary_min=$10, salary_max=$11, currency=$12, status=$13, embedding=$14::vector, updated_at=now()
     WHERE id=$1`,
    [
      jobId, input.title, input.description, input.requirements, skills, input.location, input.workMode, input.employmentType,
      input.experienceLevel, input.salaryMin ?? null, input.salaryMax ?? null, input.currency, input.status, toVector(embedding),
    ],
  );
  return getJob(jobId);
}

export async function getJob(jobId: string, db: Queryable = getDb()): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `SELECT ${JOB_SELECT} FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = $1`,
    [jobId],
  );
  return rows[0] ?? null;
}

export interface JobSearchParams {
  /** Free-text: used for full-text ranking and (when embeddings exist) semantic ranking. */
  text?: string | null;
  /** Precomputed or derived semantic query; embedded when `text` should not be. */
  semanticQuery?: string | null;
  skills?: string[];
  location?: string | null;
  workMode?: string | null;
  employmentType?: string | null;
  experienceLevel?: string | null;
  salaryMin?: number | null;
  limit?: number;
  offset?: number;
}

export interface JobSearchResult extends JobRow {
  relevance: number | null;
  similarity: number | null;
}

/**
 * Hybrid search: hard filters in SQL, ranking by a blend of pgvector cosine similarity,
 * required-skill overlap and Postgres full-text rank.
 */
export async function searchJobs(params: JobSearchParams): Promise<{ total: number; results: JobSearchResult[] }> {
  const p = new SqlParams();
  const where: string[] = ["j.status = 'open'"];
  if (params.location) where.push(`j.location ILIKE ${p.add(`%${params.location}%`)}`);
  if (params.workMode) where.push(`j.work_mode = ${p.add(params.workMode)}`);
  if (params.employmentType) where.push(`j.employment_type = ${p.add(params.employmentType)}`);
  if (params.experienceLevel) where.push(`j.experience_level = ${p.add(params.experienceLevel)}`);
  if (params.salaryMin) where.push(`coalesce(j.salary_max, j.salary_min) >= ${p.add(params.salaryMin)}`);

  const semanticText = (params.semanticQuery ?? params.text ?? "").trim();
  const text = (params.text ?? "").trim();
  const skills = normalizeSkills(params.skills ?? []);
  const hasQuery = Boolean(semanticText || text || skills.length);

  const embedding = semanticText ? await embedOne(semanticText, "query") : null;
  const { floor, ceil } = similarityRange();

  const simExpr = embedding ? `(1 - (j.embedding <=> ${p.add(toVector(embedding))}::vector))` : "NULL::float8";
  const semanticExpr = embedding
    ? `coalesce(greatest(0, least(1, (${simExpr} - ${floor}) / ${ceil - floor})), 0)`
    : "0::float8";
  const tsExpr = text ? `ts_rank(j.search_tsv, websearch_to_tsquery('english', ${p.add(text)}))` : "0::float8";
  const titleExpr = text ? `CASE WHEN j.title ILIKE ${p.add(`%${text}%`)} THEN 1 ELSE 0 END` : "0";
  const skillExpr = skills.length
    ? `((SELECT count(*) FROM unnest(j.skills) s WHERE s = ANY(${p.add(skills)}::text[]))::float8 / ${skills.length})`
    : "0::float8";

  // When embeddings are unavailable, text match carries the ranking alone.
  const wSemantic = embedding ? 0.55 : 0;
  const relevanceExpr = `(${wSemantic} * ${semanticExpr} + 0.25 * ${skillExpr} + ${embedding ? 0.1 : 0.5} * least(${tsExpr} * 10, 1) + ${embedding ? 0.1 : 0.25} * ${titleExpr})`;

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const offset = Math.max(params.offset ?? 0, 0);

  const sql = `
    WITH scored AS (
      SELECT ${JOB_SELECT}, ${simExpr} AS similarity, ${relevanceExpr} AS relevance
      FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE ${where.join(" AND ")}
    )
    SELECT *, count(*) OVER()::int AS "totalCount" FROM scored
    ${hasQuery ? "WHERE relevance > 0.08" : ""}
    ORDER BY ${hasQuery ? "relevance DESC," : ""} "createdAt" DESC
    LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`;

  const { rows } = await query<JobSearchResult & { totalCount: number }>(sql, p.values);
  return {
    total: rows[0]?.totalCount ?? 0,
    results: rows.map(({ totalCount: _t, ...r }) => ({
      ...r,
      relevance: hasQuery ? Math.round(Number(r.relevance) * 100) / 100 : null,
      similarity: r.similarity == null ? null : Math.round(Number(r.similarity) * 1000) / 1000,
    })),
  };
}
