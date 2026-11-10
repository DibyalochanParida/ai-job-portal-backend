import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "../../config.js";
import { LocalStorage } from "./local.js";
import { S3Storage } from "./s3.js";

export interface StorageDriver {
  readonly name: "local" | "s3";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Short-lived URL the browser can download the object from. */
  getDownloadUrl(key: string, fileName: string, expiresInSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (!driver) {
    driver = config.storage.driver === "s3" ? new S3Storage() : new LocalStorage(config.storage.uploadDir);
  }
  return driver;
}

/** resumes/<userId>/<uuid>.<ext>: user-controlled file names never become part of the key. */
export function resumeKey(userId: string, fileName: string): string {
  const ext = path.extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 6);
  return `resumes/${userId}/${randomUUID()}${ext}`;
}
