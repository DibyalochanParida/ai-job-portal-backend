import type { Request } from "express";
import type { z } from "zod";

/** Parse and validate the request body; ZodErrors are turned into 400s by the error handler. */
export function body<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  return schema.parse(req.body ?? {});
}

export function queryParams<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  return schema.parse(req.query ?? {});
}

export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
