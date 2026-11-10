import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { auth, registerEmployer, registerSeeker, sampleJob, setupApp } from "./helpers.js";

const resumeTxt = readFileSync(new URL("./fixtures/resume.txt", import.meta.url));

let app: Express;
let employer: { token: string };
let seeker: { token: string };
let reactJobId: string;
let dataJobId: string;
let resumeId: string;
let applicationId: string;

beforeAll(async () => {
  app = await setupApp();
  employer = await registerEmployer(app, "Flow Test Co");
  seeker = await registerSeeker(app, "Casey Fictional");
  reactJobId = (await request(app).post("/api/jobs").set(auth(employer.token)).send(sampleJob()).expect(201)).body.job.id;
  dataJobId = (
    await request(app)
      .post("/api/jobs")
      .set(auth(employer.token))
      .send(
        sampleJob({
          title: "Data Scientist",
          description: "Train machine learning models in Python for candidate ranking and forecasting.",
          requirements: "Python, PyTorch, statistics, SQL, Kubernetes for model serving.",
          skills: ["python", "pytorch", "statistics", "sql", "kubernetes"],
          experienceLevel: "mid",
        }),
      )
      .expect(201)
  ).body.job.id;
});

describe("resume upload and parsing", () => {
  it("rejects unsupported and spoofed files", async () => {
    await request(app).post("/api/resumes").set(auth(seeker.token)).attach("file", Buffer.from("MZ\x00\x00binary"), "resume.exe").expect(400);
    const res = await request(app)
      .post("/api/resumes")
      .set(auth(seeker.token))
      .attach("file", Buffer.from("not really a pdf, just text pretending"), { filename: "resume.pdf", contentType: "application/pdf" })
      .expect(400);
    expect(res.body.error.message).toMatch(/does not match/);
  });

  it("parses an uploaded resume into structured data", async () => {
    const res = await request(app).post("/api/resumes").set(auth(seeker.token)).attach("file", resumeTxt, "casey-resume.txt").expect(201);
    const { resume } = res.body;
    resumeId = resume.id;
    expect(resume.isPrimary).toBe(true);
    expect(resume.parseSource).toBe("heuristic");
    expect(resume.skills).toEqual(expect.arrayContaining(["react", "typescript", "graphql", "jest", "playwright"]));
    expect(resume.parsed).toMatchObject({ fullName: "Casey Fictional", headline: "Senior Frontend Engineer", location: "Portland, OR" });
    expect(resume.parsed.totalYearsExperience).toBeGreaterThanOrEqual(7);
    expect(resume.parsed.experience[0]).toMatchObject({ title: "Senior Frontend Engineer", company: "Example Widgets" });
    expect(resume.parsed.experience[0].highlights.length).toBeGreaterThan(0);
  });

  it("gives AI feedback, including fit for a target job", async () => {
    const general = await request(app).post(`/api/resumes/${resumeId}/feedback`).set(auth(seeker.token)).send({}).expect(201);
    expect(general.body.feedback.feedback.jobFit).toBeNull();
    expect(general.body.feedback.score).toBeGreaterThan(50);

    const targeted = await request(app).post(`/api/resumes/${resumeId}/feedback`).set(auth(seeker.token)).send({ jobId: dataJobId }).expect(201);
    const fb = targeted.body.feedback.feedback;
    expect(fb.jobFit.missingSkills).toEqual(expect.arrayContaining(["python", "pytorch"]));
    expect(fb.improvements[0].area).toMatch(/keywords/i);

    const detail = await request(app).get(`/api/resumes/${resumeId}`).set(auth(seeker.token)).expect(200);
    expect(detail.body.feedback).toHaveLength(2);
  });

  it("keeps resumes private to their owner", async () => {
    const other = await registerSeeker(app);
    await request(app).get(`/api/resumes/${resumeId}`).set(auth(other.token)).expect(404);
    const dl = await request(app).get(`/api/resumes/${resumeId}/download`).set(auth(seeker.token)).expect(200);
    const path = new URL(dl.body.url, "http://localhost").pathname;
    const file = await request(app).get(path).expect(200);
    expect(file.text).toContain("Casey Fictional");
    await request(app).get("/api/files/forged-token").expect(403);
  });
});

describe("recommendations and applications", () => {
  it("recommends the best-matching jobs first", async () => {
    const res = await request(app).get("/api/me/recommendations").set(auth(seeker.token)).expect(200);
    const ids = res.body.recommendations.map((r: { job: { id: string } }) => r.job.id);
    expect(ids.indexOf(reactJobId)).toBeLessThan(ids.indexOf(dataJobId));
    const top = res.body.recommendations.find((r: { job: { id: string } }) => r.job.id === reactJobId);
    expect(top.matchScore).toBeGreaterThan(60);
    expect(top.reasons.length).toBeGreaterThan(0);
  });

  it("applies with a match score and blocks duplicates", async () => {
    const res = await request(app).post(`/api/jobs/${reactJobId}/apply`).set(auth(seeker.token)).send({ coverLetter: "Hi!" }).expect(201);
    applicationId = res.body.application.id;
    expect(res.body.application.matchScore).toBeGreaterThan(60);
    expect(res.body.application.matchedSkills).toEqual(expect.arrayContaining(["react", "typescript"]));
    await request(app).post(`/api/jobs/${reactJobId}/apply`).set(auth(seeker.token)).send({}).expect(409);

    const rec = await request(app).get("/api/me/recommendations").set(auth(seeker.token)).expect(200);
    expect(rec.body.recommendations.map((r: { job: { id: string } }) => r.job.id)).not.toContain(reactJobId);
  });

  it("requires a resume to apply", async () => {
    const fresh = await registerSeeker(app);
    const res = await request(app).post(`/api/jobs/${reactJobId}/apply`).set(auth(fresh.token)).send({}).expect(400);
    expect(res.body.error.message).toMatch(/resume/i);
  });
});

describe("employer pipeline", () => {
  it("lists candidates ranked by match", async () => {
    const res = await request(app).get("/api/employer/candidates").set(auth(employer.token)).expect(200);
    expect(res.body.candidates[0]).toMatchObject({ id: applicationId, candidateName: "Casey Fictional", jobTitle: "Senior React Developer" });
    const outsider = await registerEmployer(app, "Nosy Co");
    const none = await request(app).get("/api/employer/candidates").set(auth(outsider.token)).expect(200);
    expect(none.body.candidates).toHaveLength(0);
    await request(app).patch(`/api/employer/applications/${applicationId}/status`).set(auth(outsider.token)).send({ status: "rejected" }).expect(403);
  });

  it("moves an application through the pipeline", async () => {
    await request(app).patch(`/api/employer/applications/${applicationId}/status`).set(auth(employer.token)).send({ status: "shortlisted" }).expect(200);

    // First-round interview that already took place (scheduling moves the candidate to "scheduled")
    const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const iv = await request(app)
      .post(`/api/employer/applications/${applicationId}/interviews`)
      .set(auth(employer.token))
      .send({ scheduledAt: earlier, durationMinutes: 45, interviewer: "Pat Lee" })
      .expect(201);

    const pending = await request(app).post("/api/employer/assistant").set(auth(employer.token)).send({ message: "Show pending interview reviews" }).expect(200);
    expect(pending.body.answer).toMatch(/1 interview review/);

    // Two upcoming interviews that overlap for the same interviewer are reported as a conflict.
    const day2 = Date.now() + 2 * 86_400_000;
    for (const at of [day2, day2 + 20 * 60_000]) {
      await request(app)
        .post(`/api/employer/applications/${applicationId}/interviews`)
        .set(auth(employer.token))
        .send({ scheduledAt: new Date(at).toISOString(), interviewer: at === day2 ? "Pat Lee" : "pat lee" })
        .expect(201);
    }
    const chat = await request(app).post("/api/employer/assistant").set(auth(employer.token)).send({ message: "Find scheduling conflicts" }).expect(200);
    expect(chat.body.source).toBe("heuristic");
    expect(chat.body.answer).toMatch(/1 conflict/);

    await request(app).patch(`/api/employer/interviews/${iv.body.interview.id}`).set(auth(employer.token)).send({ status: "completed", rating: 4, feedback: "Great" }).expect(200);

    const detail = await request(app).get(`/api/employer/applications/${applicationId}`).set(auth(employer.token)).expect(200);
    expect(detail.body.application.status).toBe("interviewed");
    expect(detail.body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(["applied", "shortlisted", "scheduled", "interviewed"]);

    const mine = await request(app).get("/api/me/applications").set(auth(seeker.token)).expect(200);
    expect(mine.body.applications[0].status).toBe("interviewed");
    expect(mine.body.applications[0].interviews).toHaveLength(3);
  });

  it("answers assistant questions about top candidates", async () => {
    const res = await request(app).post("/api/employer/assistant").set(auth(employer.token)).send({ message: "Who are my top 3 candidates?" }).expect(200);
    expect(res.body.answer).toContain("Casey Fictional");
  });

  it("reports analytics for the dashboard", async () => {
    await request(app).patch(`/api/employer/applications/${applicationId}/status`).set(auth(employer.token)).send({ status: "recommended" }).expect(200);
    const res = await request(app).get("/api/employer/analytics").query({ days: 30 }).set(auth(employer.token)).expect(200);
    const a = res.body;
    expect(a.kpis.totalCandidates.value).toBe(1);
    expect(a.kpis.totalCandidates.series).toHaveLength(8);
    expect(a.kpis.activeJobs.value).toBe(2);
    expect(a.kpis.interviewTime.value).toBe(45);
    expect(a.kpis.hireRate.value).toBe(100);
    expect(a.pipeline.stages.find((s: { key: string }) => s.key === "recommended").count).toBe(1);
    expect(a.pipeline.conversions[0]).toMatchObject({ from: "shortlisted", to: "scheduled", rate: 100 });
    expect(a.matchQuality.jobs[0].title).toBe("Senior React Developer");
  });

  it("lets the seeker withdraw", async () => {
    await request(app).post(`/api/me/applications/${applicationId}/withdraw`).set(auth(seeker.token)).expect(200);
    await request(app).patch(`/api/employer/applications/${applicationId}/status`).set(auth(employer.token)).send({ status: "selected" }).expect(400);
  });
});
