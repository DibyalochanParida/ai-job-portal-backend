import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { connectDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";

export async function setupApp(): Promise<Express> {
  const db = await connectDb();
  await runMigrations(db);
  return createApp();
}

export const PASSWORD = "Sup3rSecret!";
export const uniqueEmail = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}@test.example`;

export async function registerSeeker(app: Express, name = "Test Seeker") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ role: "seeker", email: uniqueEmail("seeker"), password: PASSWORD, fullName: name })
    .expect(201);
  return { token: res.body.token as string, user: res.body.user };
}

export async function registerEmployer(app: Express, companyName = "Test Co") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ role: "employer", email: uniqueEmail("employer"), password: PASSWORD, fullName: "Test Recruiter", companyName })
    .expect(201);
  return { token: res.body.token as string, user: res.body.user };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export const sampleJob = (overrides: Record<string, unknown> = {}) => ({
  title: "Senior React Developer",
  description: "Build delightful, accessible user interfaces for our hiring platform using React and TypeScript.",
  requirements: "5+ years with React, TypeScript and GraphQL. Testing with Jest.",
  skills: ["React", "TypeScript", "GraphQL", "Jest"],
  location: "Remote",
  workMode: "remote",
  employmentType: "full_time",
  experienceLevel: "senior",
  salaryMin: 150000,
  salaryMax: 190000,
  ...overrides,
});
