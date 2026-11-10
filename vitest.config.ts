import { defineConfig } from "vitest/config";

// Locally each test file gets its own in-memory PGlite database (pgvector included).
// In CI, TEST_DATABASE_URL points at a real PostgreSQL + pgvector service; files then run
// one at a time because they share that database.
const testDb = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: !testDb,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: testDb ?? "pglite://memory",
      JWT_SECRET: "test-secret-that-is-long-enough-for-hs256-signing",
      AI_PROVIDER: "local",
      EMBEDDINGS_PROVIDER: "local",
      STORAGE_DRIVER: "local",
      UPLOAD_DIR: ".data/test-uploads",
    },
  },
});
