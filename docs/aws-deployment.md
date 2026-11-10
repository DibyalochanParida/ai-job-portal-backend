# Deploying to AWS

```
                 ┌──────────────── Application Load Balancer (HTTPS, ACM cert) ────────────────┐
  browser ──────▶│  /api/*  → target group "api" (port 4000)    default → target group "web"    │
                 └───────────────┬─────────────────────────────────────────────┬──────────────┘
                                 ▼                                             ▼
                  ECS Fargate service "api"                       ECS Fargate service "web"
                  (ai-job-portal-backend image)                   (nginx + React bundle, port 8080)
                    │        │            │
         RDS PostgreSQL   S3 bucket    Secrets Manager
         17 + pgvector    (resumes)    (DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY, VOYAGE_API_KEY)
```

Both services run in private subnets; only the ALB is public. Because the ALB routes `/api/*`
straight to the API, the browser sees one origin: no CORS issues and `VITE_API_URL` stays empty.

## One-time setup

1. **Networking**: a VPC with two public subnets (ALB) and two private subnets (ECS, RDS), and a
   NAT gateway or VPC endpoints for ECR, S3, Secrets Manager and CloudWatch Logs.
2. **Database**: RDS for PostgreSQL 17 (Multi-AZ for production), in the private subnets, with
   encryption at rest. pgvector is available on RDS; the app runs `CREATE EXTENSION vector` in its first
   migration, so the database user needs permission to create extensions (the RDS master user has it).
   Build the connection string with `?sslmode=require` or set `DATABASE_SSL=true`.
3. **S3**: a private bucket for resumes with Block Public Access on, default SSE-S3 encryption,
   versioning on, and a lifecycle rule if you want old resumes to expire. Add a CORS rule only if
   browsers will upload directly; this app uploads through the API.
4. **Secrets Manager**: `ai-job-portal/database-url`, `ai-job-portal/jwt-secret`
   (`openssl rand -base64 48`), `ai-job-portal/anthropic-api-key`, `ai-job-portal/voyage-api-key`.
5. **ECR**: repositories `ai-job-portal-api` and `ai-job-portal-web`.
6. **IAM**
   - *Execution role* (`ai-job-portal-ecs-execution`): `AmazonECSTaskExecutionRolePolicy` plus
     `secretsmanager:GetSecretValue` on the four secrets.
   - *API task role* (`ai-job-portal-api-task`): `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`
     on `arn:aws:s3:::<bucket>/resumes/*`.
   - *GitHub deploy role*: trust policy for GitHub OIDC (`token.actions.githubusercontent.com`)
     limited to `repo:<owner>/ai-job-portal-backend:ref:refs/heads/main` (and the frontend repo);
     permissions for `ecr:*` push on the two repositories, `ecs:RegisterTaskDefinition`,
     `ecs:UpdateService`, `ecs:DescribeServices`, and `iam:PassRole` on the two task roles.
7. **ECS**: a cluster with two Fargate services (`api` with desired count ≥ 2, `web`), each attached
   to its ALB target group. API health check path: `/api/health`; web: `/healthz`.
   Edit `.aws/task-definition.json` in each repo, replacing the `<ACCOUNT_ID>`, `<AWS_REGION>`,
   `<RESUME_BUCKET_NAME>` and `<YOUR_DOMAIN>` placeholders.
8. **ALB**: HTTPS listener with an ACM certificate; rule `/api/*` → api target group, default → web.
   Redirect HTTP to HTTPS. Set the API's `TRUST_PROXY=true` (already in the task definition) so rate
   limiting sees client IPs.

## GitHub Actions

In each repository, set **Settings → Secrets and variables → Actions → Variables**:

| Variable | Backend | Frontend |
| --- | --- | --- |
| `AWS_REGION` | ✓ | ✓ |
| `AWS_DEPLOY_ROLE_ARN` | ✓ | ✓ |
| `ECS_CLUSTER` | ✓ | ✓ |
| `ECR_REPOSITORY_API` / `ECR_REPOSITORY_WEB` | `ai-job-portal-api` | `ai-job-portal-web` |
| `ECS_SERVICE_API` / `ECS_SERVICE_WEB` | `api` | `web` |

Create a `production` environment with required reviewers if you want manual approval before deploys.
On every push to `main`, `deploy.yml` runs the CI workflow, builds the image tagged with the commit
SHA, pushes it to ECR, renders the task definition with the new image and waits for the ECS service
to stabilise. Database migrations run on API startup, serialised by a Postgres advisory lock, so
rolling deploys are safe. Keep migrations backwards compatible with the previous release.

## Operations

- Logs: CloudWatch Logs groups `/ecs/ai-job-portal-api` and `/ecs/ai-job-portal-web` (JSON logs from pino;
  authorization headers are redacted).
- Scaling: target-tracking on CPU for the API service; resume parsing and feedback are the heaviest
  calls (dominated by Claude latency, so keep the ALB idle timeout ≥ 120 s).
- Backups: RDS automated backups + point-in-time recovery; S3 versioning for resumes.
- Seeding a staging environment: run a one-off ECS task with the API image and command
  `node dist/db/seed.js`.
