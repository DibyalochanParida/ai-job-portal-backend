import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import jwt from "jsonwebtoken";
import { config } from "../../config.js";
import type { StorageDriver } from "./index.js";

interface FileTokenPayload {
  key: string;
  name: string;
  purpose: "file";
}

/**
 * Local-disk storage for development. Download URLs point at GET /api/files/:token, where
 * the token is a short-lived signed JWT, mirroring how S3 presigned URLs behave.
 */
export class LocalStorage implements StorageDriver {
  readonly name = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async getDownloadUrl(key: string, fileName: string, expiresInSeconds = 300): Promise<string> {
    const token = jwt.sign({ key, name: fileName, purpose: "file" } satisfies FileTokenPayload, config.jwtSecret, {
      expiresIn: expiresInSeconds,
      algorithm: "HS256",
    });
    return `${config.publicApiUrl}/api/files/${token}`;
  }

  verifyToken(token: string): FileTokenPayload {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as FileTokenPayload;
    if (payload.purpose !== "file") throw new Error("Invalid file token");
    return payload;
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
