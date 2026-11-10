import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { auth, registerEmployer, registerSeeker, sampleJob, setupApp } from "./helpers.js";

let app: Express;
let employer: { token: string };
const createdIds: Record<string, string> = {};

beforeAll(async () => {
  app = await setupApp();
  employer = await registerEmployer(app, "Search Test Co");
  const jobs = {
    react: sampleJob(),
    devops: sampleJob({
      title: "DevOps Engineer",
      description: "Operate our Kubernetes clusters on AWS and automate infrastructure with Terraform.",
      requirements: "Kubernetes, Terraform, AWS, Docker and CI/CD pipelines.",
      skills: ["kubernetes", "terraform", "aws", "docker"],
      location: "Austin, TX",
      workMode: "onsite",
      experienceLevel: "mid",
      salaryMin: 120000,
      salaryMax: 140000,
    }),
    data: sampleJob({
      title: "Data Scientist",
      description: "Build machine learning models for candidate ranking using Python and PyTorch.",
      requirements: "Python, statistics, machine learning, SQL.",
      skills: ["python", "machine learning", "sql", "pytorch"],
      location: "Berlin, Germany",
      workMode: "hybrid",
      employmentType: "contract",
      salaryMin: null,
      salaryMax: null,
    }),
  };
  for (const [key, job] of Object.entries(jobs)) {
    const res = await request(app).post("/api/jobs").set(auth(employer.token)).send(job).expect(201);
    createdIds[key] = res.body.job.id;
  }
});

describe("job posting", () => {
  it("normalises skills and returns the created job", async () => {
    const res = await request(app).get(`/api/jobs/${createdIds.react}`).expect(200);
    expect(res.body.job).toMatchObject({ title: "Senior React Developer", companyName: "Search Test Co", workMode: "remote" });
    expect(res.body.job.skills).toEqual(["react", "typescript", "graphql", "jest"]);
    expect(res.body.job.embedding).toBeUndefined();
  });

  it("rejects invalid salary ranges", async () => {
    await request(app).post("/api/jobs").set(auth(employer.token)).send(sampleJob({ salaryMin: 200000, salaryMax: 100000 })).expect(400);
  });

  it("only lets the owning employer edit a job", async () => {
    const seeker = await registerSeeker(app);
    await request(app).post("/api/jobs").set(auth(seeker.token)).send(sampleJob()).expect(403);

    const other = await registerEmployer(app, "Other Co");
    await request(app).put(`/api/jobs/${createdIds.react}`).set(auth(other.token)).send(sampleJob({ title: "Hijacked" })).expect(403);

    const res = await request(app)
      .put(`/api/jobs/${createdIds.react}`)
      .set(auth(employer.token))
      .send(sampleJob({ title: "Senior React Engineer" }))
      .expect(200);
    expect(res.body.job.title).toBe("Senior React Engineer");
  });

  it("hides closed jobs from the board but keeps them viewable", async () => {
    const res = await request(app).post("/api/jobs").set(auth(employer.token)).send(sampleJob({ title: "Closed Role", status: "closed" })).expect(201);
    const list = await request(app).get("/api/jobs").expect(200);
    expect(list.body.results.map((j: { id: string }) => j.id)).not.toContain(res.body.job.id);
    await request(app).get(`/api/jobs/${res.body.job.id}`).expect(200);
  });
});

describe("search", () => {
  it("filters the job board with structured params", async () => {
    const res = await request(app).get("/api/jobs").query({ workMode: "onsite" }).expect(200);
    const ids = res.body.results.map((j: { id: string }) => j.id);
    expect(ids).toContain(createdIds.devops);
    expect(ids).not.toContain(createdIds.react);
    expect(ids).not.toContain(createdIds.data);
  });

  it("ranks keyword queries by relevance", async () => {
    const res = await request(app).get("/api/jobs").query({ q: "kubernetes terraform" }).expect(200);
    expect(res.body.results[0].title).toBe("DevOps Engineer");
    expect(res.body.results[0].relevance).toBeGreaterThan(0);
  });

  it("understands natural-language queries", async () => {
    const res = await request(app).post("/api/jobs/search").send({ query: "remote senior react typescript jobs paying over 140k" }).expect(200);
    expect(res.body.source).toBe("heuristic");
    expect(res.body.interpretation).toMatchObject({ workMode: "remote", experienceLevel: "senior", salaryMin: 140000 });
    expect(res.body.interpretation.skills).toEqual(expect.arrayContaining(["react", "typescript"]));
    const ids = res.body.results.map((j: { id: string }) => j.id);
    expect(ids).toContain(createdIds.react);
    expect(ids).not.toContain(createdIds.devops);
    expect(ids).not.toContain(createdIds.data);
  });

  it("extracts location and employment type", async () => {
    const res = await request(app).post("/api/jobs/search").send({ query: "machine learning contract work in Berlin" }).expect(200);
    expect(res.body.interpretation).toMatchObject({ location: "Berlin", employmentType: "contract" });
    expect(res.body.results[0].title).toBe("Data Scientist");
  });
});
