import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { getDb, query, toVector } from "../db/index.js";
import { badRequest, notFound } from "../lib/errors.js";
import { logger } from "../logger.js";
import { currentUser, requireRole } from "../middleware/auth.js";
import { isUuid } from "../middleware/error.js";
import { aiLimiter } from "../middleware/rateLimit.js";
import { body, param } from "../middleware/validate.js";
import { embedOne } from "../services/ai/embeddings.js";
import { generateResumeFeedback } from "../services/ai/resumeFeedback.js";
import {
  extractResumeText,
  parseResume,
  resumeEmbeddingText,
  SUPPORTED_RESUME_TYPES,
  type ParsedResume,
} from "../services/ai/resumeParser.js";
import { resumeKey, storage } from "../services/storage/index.js";
import { getJob } from "../services/jobs.service.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Some browsers send DOCX/MD with generic types; fall back to the extension.
    const byExt: Record<string, string> = {
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".txt": "text/plain",
      ".md": "text/markdown",
    };
    const ext = file.originalname.toLowerCase().match(/\.[a-z]+$/)?.[0] ?? "";
    const mime = SUPPORTED_RESUME_TYPES[file.mimetype] ? file.mimetype : byExt[ext];
    if (!mime) return cb(badRequest("Unsupported file type. Upload a PDF, DOCX or TXT resume."));
    file.mimetype = mime;
    cb(null, true);
  },
});

const RESUME_SELECT = `id, file_name AS "fileName", mime_type AS "mimeType", size_bytes AS "sizeBytes", parsed, skills,
  parse_source AS "parseSource", is_primary AS "isPrimary", created_at AS "createdAt"`;

/** Magic-byte check so a renamed executable can't be stored as a "PDF". */
function looksLike(buffer: Buffer, mime: string): boolean {
  if (mime === "application/pdf") return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  if (mime.includes("wordprocessingml")) return buffer[0] === 0x50 && buffer[1] === 0x4b; // zip
  return !buffer.subarray(0, 4096).includes(0); // text: no NUL bytes
}

router.post("/", requireRole("seeker"), aiLimiter, upload.single("file"), async (req, res) => {
  const me = currentUser(req);
  const file = req.file;
  if (!file) throw badRequest("Attach a resume file in the 'file' field");
  if (!looksLike(file.buffer, file.mimetype)) throw badRequest("File content does not match its type");

  const rawText = await extractResumeText(file.buffer, file.mimetype);
  const { parsed, skills, source } = await parseResume(rawText);
  const embedding = await embedOne(resumeEmbeddingText(parsed, rawText), "document");

  const key = resumeKey(me.id, file.originalname);
  await storage().put(key, file.buffer, file.mimetype);

  try {
    const resume = await getDb().transaction(async (tx) => {
      const hasPrimary = (await tx.query("SELECT 1 FROM resumes WHERE user_id = $1 AND is_primary", [me.id])).rowCount > 0;
      const { rows } = await tx.query(
        `INSERT INTO resumes (user_id, file_key, file_name, mime_type, size_bytes, raw_text, parsed, skills, parse_source, embedding, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::vector,$11) RETURNING ${RESUME_SELECT}`,
        [me.id, key, file.originalname.slice(0, 200), file.mimetype, file.size, rawText, JSON.stringify(parsed), skills, source, toVector(embedding), !hasPrimary],
      );
      return rows[0];
    });
    res.status(201).json({ resume });
  } catch (err) {
    await storage().delete(key).catch((e) => logger.warn({ e }, "Failed to clean up orphaned upload"));
    throw err;
  }
});

router.get("/", requireRole("seeker"), async (req, res) => {
  const { rows } = await query(
    `SELECT ${RESUME_SELECT},
       (SELECT json_build_object('score', f.score, 'createdAt', f.created_at) FROM resume_feedback f
        WHERE f.resume_id = resumes.id ORDER BY f.created_at DESC LIMIT 1) AS "latestFeedback"
     FROM resumes WHERE user_id = $1 ORDER BY created_at DESC`,
    [currentUser(req).id],
  );
  res.json({ resumes: rows });
});

async function ownedResume(userId: string, id: string) {
  if (!isUuid(id)) throw notFound("Resume");
  const { rows } = await query<{ id: string; fileKey: string; fileName: string; rawText: string; parsed: ParsedResume }>(
    `SELECT id, file_key AS "fileKey", file_name AS "fileName", raw_text AS "rawText", parsed FROM resumes WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!rows[0]) throw notFound("Resume");
  return rows[0];
}

router.get("/:id", requireRole("seeker"), async (req, res) => {
  const me = currentUser(req);
  const id = param(req, "id");
  await ownedResume(me.id, id);
  const [{ rows: resume }, { rows: feedback }] = await Promise.all([
    query(`SELECT ${RESUME_SELECT} FROM resumes WHERE id = $1`, [id]),
    query(
      `SELECT f.id, f.score, f.feedback, f.source, f.created_at AS "createdAt", f.job_id AS "jobId", j.title AS "jobTitle"
       FROM resume_feedback f LEFT JOIN jobs j ON j.id = f.job_id WHERE f.resume_id = $1 ORDER BY f.created_at DESC LIMIT 10`,
      [id],
    ),
  ]);
  res.json({ resume: resume[0], feedback });
});

router.get("/:id/download", requireRole("seeker"), async (req, res) => {
  const r = await ownedResume(currentUser(req).id, param(req, "id"));
  res.json({ url: await storage().getDownloadUrl(r.fileKey, r.fileName) });
});

router.post("/:id/primary", requireRole("seeker"), async (req, res) => {
  const me = currentUser(req);
  const id = param(req, "id");
  await ownedResume(me.id, id);
  await getDb().transaction(async (tx) => {
    await tx.query("UPDATE resumes SET is_primary = false WHERE user_id = $1 AND is_primary", [me.id]);
    await tx.query("UPDATE resumes SET is_primary = true WHERE id = $1", [id]);
  });
  res.json({ ok: true });
});

router.delete("/:id", requireRole("seeker"), async (req, res) => {
  const me = currentUser(req);
  const r = await ownedResume(me.id, param(req, "id"));
  await getDb().transaction(async (tx) => {
    const { rows } = await tx.query<{ is_primary: boolean }>("DELETE FROM resumes WHERE id = $1 RETURNING is_primary", [r.id]);
    if (rows[0]?.is_primary) {
      await tx.query(
        `UPDATE resumes SET is_primary = true WHERE id = (SELECT id FROM resumes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
        [me.id],
      );
    }
  });
  await storage().delete(r.fileKey).catch((err) => logger.warn({ err }, "Failed to delete resume file"));
  res.status(204).end();
});

router.post("/:id/feedback", requireRole("seeker"), aiLimiter, async (req, res) => {
  const me = currentUser(req);
  const r = await ownedResume(me.id, param(req, "id"));
  const { jobId } = body(req, z.object({ jobId: z.uuid().nullable().optional() }));
  const job = jobId ? await getJob(jobId) : null;
  if (jobId && !job) throw notFound("Job");

  const { feedback, source } = await generateResumeFeedback({ rawText: r.rawText, parsed: r.parsed, job });
  const { rows } = await query(
    `INSERT INTO resume_feedback (resume_id, job_id, score, feedback, source) VALUES ($1,$2,$3,$4::jsonb,$5)
     RETURNING id, score, feedback, source, created_at AS "createdAt", job_id AS "jobId"`,
    [r.id, job?.id ?? null, feedback.overallScore, JSON.stringify(feedback), source],
  );
  res.status(201).json({ feedback: { ...rows[0], jobTitle: job?.title ?? null } });
});

export default router;
