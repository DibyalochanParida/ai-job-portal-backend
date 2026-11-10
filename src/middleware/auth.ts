import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { forbidden, unauthorized } from "../lib/errors.js";

export type Role = "seeker" | "employer";

export interface AuthUser {
  id: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface TokenPayload {
  sub: string;
  role: Role;
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ role: user.role } satisfies Omit<TokenPayload, "sub">, config.jwtSecret, {
    subject: user.id,
    expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"],
    algorithm: "HS256",
  });
}

export function verifyToken(token: string): AuthUser {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload & TokenPayload;
  if (!payload.sub || (payload.role !== "seeker" && payload.role !== "employer")) {
    throw unauthorized("Invalid token");
  }
  return { id: payload.sub, role: payload.role };
}

function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/** Attaches req.user when a valid token is present; never rejects. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (token) {
    try {
      req.user = verifyToken(token);
    } catch {
      // ignore: treated as anonymous
    }
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (!token) return next(unauthorized());
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (!req.user || !roles.includes(req.user.role)) return next(forbidden(`This action requires a ${roles.join(" or ")} account`));
      next();
    });
  };
}

/** Use after requireAuth/requireRole. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
