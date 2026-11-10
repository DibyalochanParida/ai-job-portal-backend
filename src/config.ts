import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: bool.default(false),

  // postgres://user:pass@host:5432/db  |  pglite://memory  |  pglite://./.data/pglite
  DATABASE_URL: z.string().min(1).default("pglite://./.data/pglite"),
  DATABASE_SSL: bool.default(false),
  RUN_MIGRATIONS: bool.default(true),

  JWT_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default("1d"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  // AI: "auto" uses Claude when ANTHROPIC_API_KEY is set, otherwise the local heuristic engine.
  AI_PROVIDER: z.enum(["auto", "anthropic", "local"]).default("auto"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),

  // Embeddings: "auto" uses Voyage AI when VOYAGE_API_KEY is set, otherwise local feature hashing.
  EMBEDDINGS_PROVIDER: z.enum(["auto", "voyage", "local"]).default("auto"),
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_MODEL: z.string().default("voyage-3.5"),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(5),
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),

  PUBLIC_API_URL: z.string().default(""),
  RATE_LIMIT_ENABLED: bool.optional(),
});

// Treat empty values (e.g. `JWT_SECRET=` copied from .env.example) as unset.
const env = EnvSchema.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));

const DEV_JWT_SECRET = "dev-only-insecure-secret-change-me-0123456789";

if (env.NODE_ENV === "production") {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 characters in production");
  }
  if (env.DATABASE_URL.startsWith("pglite:")) {
    throw new Error("Use a real PostgreSQL DATABASE_URL in production (pglite is for local dev and tests)");
  }
  if (env.STORAGE_DRIVER === "s3" && !env.S3_BUCKET) {
    throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
  }
}

const aiProvider =
  env.AI_PROVIDER === "auto" ? (env.ANTHROPIC_API_KEY ? "anthropic" : "local") : env.AI_PROVIDER;
const embeddingsProvider =
  env.EMBEDDINGS_PROVIDER === "auto"
    ? env.VOYAGE_API_KEY
      ? "voyage"
      : "local"
    : env.EMBEDDINGS_PROVIDER;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  port: env.PORT,
  logLevel: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  trustProxy: env.TRUST_PROXY,
  databaseUrl: env.DATABASE_URL,
  databaseSsl: env.DATABASE_SSL,
  runMigrations: env.RUN_MIGRATIONS,
  jwtSecret: env.JWT_SECRET ?? DEV_JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  corsOrigins: env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean),
  ai: {
    provider: aiProvider as "anthropic" | "local",
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL,
  },
  embeddings: {
    provider: embeddingsProvider as "voyage" | "local",
    voyageApiKey: env.VOYAGE_API_KEY,
    voyageModel: env.VOYAGE_MODEL,
  },
  storage: {
    driver: env.STORAGE_DRIVER,
    uploadDir: env.UPLOAD_DIR,
    maxUploadBytes: Math.round(env.MAX_UPLOAD_MB * 1024 * 1024),
    s3Bucket: env.S3_BUCKET,
    awsRegion: env.AWS_REGION,
    s3Endpoint: env.S3_ENDPOINT,
    s3ForcePathStyle: env.S3_FORCE_PATH_STYLE,
  },
  publicApiUrl: env.PUBLIC_API_URL,
  rateLimitEnabled: env.RATE_LIMIT_ENABLED ?? env.NODE_ENV !== "test",
} as const;

export const usingDevJwtSecret = !env.JWT_SECRET;
