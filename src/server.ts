import { createApp } from "./app.js";
import { config, usingDevJwtSecret } from "./config.js";
import { closeDb, connectDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./logger.js";

async function main() {
  const db = await connectDb();
  if (config.runMigrations) {
    const applied = await runMigrations(db);
    if (applied.length) logger.info({ applied }, "Applied database migrations");
  }
  if (usingDevJwtSecret) logger.warn("JWT_SECRET is not set; using an insecure development secret");
  logger.info(
    { ai: config.ai.provider, embeddings: config.embeddings.provider, storage: config.storage.driver, db: db.kind },
    "Providers configured",
  );

  const server = createApp().listen(config.port, () => logger.info(`API listening on http://localhost:${config.port}`));

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
