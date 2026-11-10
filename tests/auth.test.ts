import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { auth, PASSWORD, registerEmployer, registerSeeker, setupApp, uniqueEmail } from "./helpers.js";

let app: Express;
beforeAll(async () => {
  app = await setupApp();
});

describe("auth", () => {
  it("registers a job seeker and returns a token", async () => {
    const { token, user } = await registerSeeker(app, "Robin Test");
    expect(token).toBeTypeOf("string");
    expect(user).toMatchObject({ role: "seeker", fullName: "Robin Test", company: null });
    expect(user.passwordHash).toBeUndefined();
  });

  it("registers an employer together with a company", async () => {
    const { user } = await registerEmployer(app, "Example Corp");
    expect(user.role).toBe("employer");
    expect(user.company).toMatchObject({ name: "Example Corp" });
  });

  it("rejects duplicate emails case-insensitively", async () => {
    const email = uniqueEmail("dup");
    await request(app).post("/api/auth/register").send({ role: "seeker", email, password: PASSWORD, fullName: "One" }).expect(201);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ role: "seeker", email: email.toUpperCase(), password: PASSWORD, fullName: "Two" })
      .expect(409);
    expect(res.body.error.message).toMatch(/already exists/);
  });

  it("validates input", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ role: "employer", email: "not-an-email", password: "short", fullName: "X" })
      .expect(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["email", "password", "fullName", "companyName"]));
  });

  it("logs in with correct credentials only", async () => {
    const email = uniqueEmail("login");
    await request(app).post("/api/auth/register").send({ role: "seeker", email, password: PASSWORD, fullName: "Login Test" }).expect(201);

    const ok = await request(app).post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
    expect(ok.body.user.email).toBe(email);

    await request(app).post("/api/auth/login").send({ email, password: "Wrong-pass-1" }).expect(401);
    await request(app).post("/api/auth/login").send({ email: uniqueEmail("nobody"), password: PASSWORD }).expect(401);
  });

  it("protects /me and enforces roles", async () => {
    await request(app).get("/api/auth/me").expect(401);
    await request(app).get("/api/auth/me").set(auth("garbage")).expect(401);

    const seeker = await registerSeeker(app);
    const me = await request(app).get("/api/auth/me").set(auth(seeker.token)).expect(200);
    expect(me.body.user.id).toBe(seeker.user.id);

    // seekers cannot use employer endpoints, employers cannot use seeker endpoints
    await request(app).get("/api/employer/analytics").set(auth(seeker.token)).expect(403);
    const employer = await registerEmployer(app);
    await request(app).get("/api/me/recommendations").set(auth(employer.token)).expect(403);
  });
});
