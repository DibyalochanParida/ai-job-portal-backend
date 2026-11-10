# ai-job-portal-backend

REST API for an AI-powered job portal: job seekers upload resumes and get AI feedback,
recommendations and natural-language search; employers post jobs, manage a hiring
pipeline, and get analytics plus an AI recruiting assistant.

The React frontend lives in [ai-job-portal-frontend](https://github.com/DibyalochanParida/ai-job-portal-frontend).

| Concern | Technology |
| --- | --- |
| Runtime / API | Node.js 24, Express 5, TypeScript, Zod validation |
| Database | PostgreSQL 17 + **pgvector** (HNSW index), full-text search (`tsvector`) |
| Auth | JWT (HS256) bearer tokens, bcrypt password hashing, role-based access (seeker / employer) |
| AI: parsing, feedback, NL search, assistant | Claude (`claude-opus-5-5`) through the Anthropic SDK: structured outputs + tool use |
| AI: matching & semantic search | Embeddings (Voyage AI `voyage-3.5`, 1024-d) + pgvector cosine similarity |
| Document storage | AWS S3 (SSE, presigned downloads); local disk in development |
| Deployment | Docker, Amazon ECS Fargate, RDS, ECR; GitHub Actions CI/CD with OIDC |

## Features

1. **Registration**: job seekers and employers (an employer account creates its company).
2. **Jobs & applications**: employers create, edit, close and delete postings; seekers apply with a
   resume and cover letter; employers move applicants through
   `applied → shortlisted → scheduled → interviewed → recommended → selected` (or `rejected`),
   schedule interviews and record feedback. Every stage change is kept in `application_events`.
3. **Resume upload & parsing**: PDF, DOCX or TXT (5 MB max, MIME + magic-byte checks). Text is
   extracted (`unpdf`, `mammoth`), then Claude returns a typed profile (headline, skills,
   experience, education…). The file goes to S3 under a random key.
4. **AI resume feedback**: score, strengths, prioritised improvements, missing keywords and ATS tips;
   optionally tailored to a specific job (`jobFit`).
5. **AI job recommendations**: nearest open jobs to the resume embedding (pgvector), re-ranked
   by required-skill coverage, with human-readable reasons.
6. **Natural-language job search**: "remote senior React roles over $150k" → Claude extracts
   filters (work mode, level, location, salary, skills) → hybrid ranking of semantic similarity,
   skill overlap and Postgres full-text rank.
7. **Employer dashboard & analytics**: KPIs with period-over-period deltas and sparklines, pipeline
   health and stage conversion, AI match quality per job, most common skill gaps, upcoming interviews,
   and an **AI assistant** that answers questions ("Who are my top 3 candidates?", "Find scheduling
   conflicts") by calling tools over the employer's own data.

### AI design

- **Graceful degradation.** Every AI feature has a deterministic fallback (rules-based parser,
  feedback rubric, query parser, assistant intents; feature-hashing embeddings). With no API keys
  the whole product works offline; responses carry `source: "claude" | "heuristic"` so the UI can
  say which engine ran. Claude errors (rate limits, outages) fall back per request and are logged.
- **Structured outputs.** Claude calls use `client.beta.messages.parse()` with Zod schemas, so
  responses are validated before use. Refusals and truncation are checked explicitly.
- **Server-side refusal fallbacks** are enabled (`fallbacks: "default"`) on every Claude request.
- **Prompt-injection hygiene.** Resume and query text is wrapped in tags and treated as data;
  assistant tools are scoped to the caller's company and never return contact details.
- **Embedding consistency.** Vectors from different models are never mixed: if the provider
  fails, the row is stored without an embedding (search falls back to full-text). After changing
  `EMBEDDINGS_PROVIDER` or `VOYAGE_MODEL`, run `npm run reembed`.

## Quick start (no Docker, no API keys)

Requires Node.js 22+. The default `DATABASE_URL` uses **PGlite**, an embedded PostgreSQL with
pgvector, so nothing else needs installing.

```bash
npm install
npm run seed      # demo companies, jobs, 45 candidates and a realistic pipeline
npm run dev       # http://localhost:4000/api/health
```

Demo accounts: `employer@demo.example` and `seeker@demo.example`; the password is
`SEED_DEMO_PASSWORD` in [.env.example](.env.example). Start the frontend next to it and open
http://localhost:5173.

To enable Claude and Voyage, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` and
`VOYAGE_API_KEY` (then `npm run reembed`).

## With Docker (PostgreSQL + pgvector)

```bash
cp .env.example .env          # set JWT_SECRET to 32+ random characters
docker compose up --build     # postgres + api
docker compose exec api node dist/db/seed.js
docker compose --profile web up --build   # also builds ../ai-job-portal-frontend on :8080
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | API with reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled server |
| `npm run typecheck` | Type-check source and tests |
| `npm test` | Vitest + Supertest integration tests (PGlite locally, Postgres in CI) |
| `npm run migrate` | Apply migrations (also run on startup when `RUN_MIGRATIONS=true`) |
| `npm run seed [-- --reset]` | Load demo data |
| `npm run reembed` | Recompute all embeddings with the current provider |

## API

All routes are under `/api`. Authenticated routes need `Authorization: Bearer <token>`.
Errors look like `{ "error": { "message": "...", "details": [{ "path", "message" }] } }`.

| Method & path | Who | Description |
| --- | --- | --- |
| `GET /health` | public | Liveness + which AI/embedding/storage providers are active |
| `POST /auth/register` | public | `{ role, email, password, fullName, companyName? }` → `{ token, user }` |
| `POST /auth/login` | public | `{ email, password }` → `{ token, user }` |
| `GET /auth/me` · `PATCH /auth/company` | any / employer | Current user · update company profile |
| `GET /jobs` | public | Browse open jobs; `q`, `skills`, `location`, `workMode`, `employmentType`, `experienceLevel`, `salaryMin`, `page`, `limit` |
| `POST /jobs/search` | public | Natural-language search `{ query }` → `{ interpretation, source, results }` |
| `GET /jobs/:id` | public | Job detail (+ your application if you're a seeker) |
| `POST /jobs` · `PUT /jobs/:id` · `PATCH /jobs/:id/status` · `DELETE /jobs/:id` | employer (owner) | Manage postings |
| `POST /jobs/:id/apply` | seeker | `{ resumeId?, coverLetter? }` → match score, matched & missing skills |
| `POST /resumes` | seeker | Multipart `file` upload → parsed resume |
| `GET /resumes` · `GET /resumes/:id` · `GET /resumes/:id/download` | seeker (owner) | List, detail + feedback history, presigned download URL |
| `POST /resumes/:id/primary` · `DELETE /resumes/:id` | seeker (owner) | Set primary · delete (also removes the file) |
| `POST /resumes/:id/feedback` | seeker (owner) | `{ jobId? }` → AI feedback |
| `GET /me/recommendations` · `GET /me/applications` · `POST /me/applications/:id/withdraw` | seeker | Recommendations, applications, withdraw |
| `GET /employer/jobs` · `GET /employer/candidates` | employer | Jobs with stats · applicants (`jobId`, `status`, `q`, `sort`) |
| `GET /employer/applications/:id` · `PATCH …/:id/status` · `GET …/:id/resume` | employer | Application detail & history · change stage · resume download |
| `POST /employer/applications/:id/interviews` · `GET /employer/interviews` · `PATCH /employer/interviews/:id` | employer | Schedule, list, complete/cancel interviews |
| `GET /employer/analytics?days=30` | employer | Dashboard data |
| `POST /employer/assistant` | employer | `{ message, history }` → `{ answer, source }` |

## Security notes

- Passwords: bcrypt (cost 12); login compares against a dummy hash for unknown emails.
- JWT secret must be 32+ characters in production (startup fails otherwise); tokens expire (`JWT_EXPIRES_IN`).
- Rate limits: 300 req/min general, 30 auth attempts / 15 min, 20 AI calls/min per user.
- Helmet headers, strict CORS allow-list, 1 MB JSON limit, Zod validation on every input.
- Uploads: type allow-list, magic-byte check, size limit, random storage keys, S3 server-side
  encryption, short-lived presigned download URLs, authorization on every download.

## Deployment

See [docs/aws-deployment.md](docs/aws-deployment.md) for the AWS architecture (ECS Fargate,
RDS PostgreSQL with pgvector, S3, ALB, Secrets Manager) and the GitHub Actions setup.
CI (`.github/workflows/ci.yml`) runs typecheck, tests against PostgreSQL + pgvector, build and
a Docker build on every pull request; `deploy.yml` deploys `main` to ECS once AWS is configured.
