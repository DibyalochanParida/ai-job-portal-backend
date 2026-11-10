import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import multer from "multer";
import { HttpError } from "../lib/errors.js";
import { logger } from "../logger.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found` } });
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: "Validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { message: err.message, details: err.details } });
    return;
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(status).json({ error: { message: err.message } });
    return;
  }
  // Malformed JSON body
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { message: "Invalid JSON body" } });
    return;
  }
  // Postgres errors
  const code = (err as { code?: string })?.code;
  if (code === "23505") {
    res.status(409).json({ error: { message: "This record already exists" } });
    return;
  }
  if (code === "22P02") {
    res.status(400).json({ error: { message: "Invalid identifier or value" } });
    return;
  }
  if (code === "23503") {
    res.status(400).json({ error: { message: "Referenced record does not exist" } });
    return;
  }

  // http-errors style (body-parser, send, ...): trust their 4xx status
  const status = (err as { status?: number })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: { message: (err as Error).message } });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, "Unhandled error");
  res.status(500).json({ error: { message: "Internal server error" } });
};
