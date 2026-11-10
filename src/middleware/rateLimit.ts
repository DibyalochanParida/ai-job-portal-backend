import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";
import { config } from "../config.js";

const passthrough: RequestHandler = (_req, _res, next) => next();

function limiter(windowMs: number, limit: number, message: string): RequestHandler {
  if (!config.rateLimitEnabled) return passthrough;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Authenticated requests are limited per user, anonymous ones per IP.
    keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? "unknown"),
    message: { error: { message } },
  });
}

export const apiLimiter = limiter(60_000, 300, "Too many requests, please slow down");
export const authLimiter = limiter(15 * 60_000, 30, "Too many authentication attempts, try again later");
export const aiLimiter = limiter(60_000, 20, "AI request limit reached, try again in a minute");
