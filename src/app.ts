import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { query } from "./db/index.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { LocalStorage } from "./services/storage/local.js";
import { storage } from "./services/storage/index.js";
import authRoutes from "./routes/auth.routes.js";
import jobsRoutes from "./routes/jobs.routes.js";
import resumesRoutes from "./routes/resumes.routes.js";
import seekerRoutes from "./routes/seeker.routes.js";
import employerRoutes from "./routes/employer.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes("*") || config.corsOrigins.includes(origin)),
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  if (!config.isTest) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/health" } }));
  }

  app.get("/api/health", async (_req, res) => {
    await query("SELECT 1");
    res.json({
      status: "ok",
      ai: config.ai.provider,
      model: config.ai.provider === "anthropic" ? config.ai.model : null,
      embeddings: config.embeddings.provider,
      storage: config.storage.driver,
    });
  });

  // Signed download links for the local storage driver (S3 uses presigned URLs instead).
  app.get("/api/files/:token", async (req, res) => {
    const driver = storage();
    if (!(driver instanceof LocalStorage)) {
      res.status(404).end();
      return;
    }
    let payload;
    try {
      payload = driver.verifyToken(req.params.token);
    } catch {
      res.status(403).json({ error: { message: "This download link is invalid or has expired" } });
      return;
    }
    // dotfiles: the upload dir may live under a dot-folder such as .data/
    res.download(driver.resolve(payload.key), payload.name.replace(/[^\w.\- ]/g, "_"), { dotfiles: "allow" });
  });

  app.use("/api", apiLimiter);
  app.use("/api/auth", authRoutes);
  app.use("/api/jobs", jobsRoutes);
  app.use("/api/resumes", resumesRoutes);
  app.use("/api/me", seekerRoutes);
  app.use("/api/employer", employerRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
