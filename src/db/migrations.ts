/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped;
 * add a new entry instead. Embedding columns are vector(1024), matching
 * EMBEDDING_DIMENSIONS in services/ai/embeddings.ts.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: "001_init",
    sql: /* sql */ `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  role          text NOT NULL CHECK (role IN ('seeker', 'employer')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  website     text,
  industry    text,
  size        text,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  posted_by        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text NOT NULL,
  requirements     text NOT NULL DEFAULT '',
  skills           text[] NOT NULL DEFAULT '{}',
  location         text NOT NULL DEFAULT '',
  work_mode        text NOT NULL DEFAULT 'onsite' CHECK (work_mode IN ('onsite', 'remote', 'hybrid')),
  employment_type  text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'internship')),
  experience_level text NOT NULL DEFAULT 'mid' CHECK (experience_level IN ('entry', 'mid', 'senior', 'lead')),
  salary_min       integer,
  salary_max       integer,
  currency         text NOT NULL DEFAULT 'USD',
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'closed')),
  embedding        vector(1024),
  search_tsv       tsvector GENERATED ALWAYS AS (
                     to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(requirements, ''))
                   ) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
);
CREATE INDEX jobs_status_created_idx ON jobs (status, created_at DESC);
CREATE INDEX jobs_company_idx ON jobs (company_id);
CREATE INDEX jobs_search_idx ON jobs USING gin (search_tsv);
CREATE INDEX jobs_skills_idx ON jobs USING gin (skills);
CREATE INDEX jobs_embedding_idx ON jobs USING hnsw (embedding vector_cosine_ops);

CREATE TABLE resumes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_key     text NOT NULL,
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   integer NOT NULL,
  raw_text     text NOT NULL DEFAULT '',
  parsed       jsonb NOT NULL DEFAULT '{}'::jsonb,
  skills       text[] NOT NULL DEFAULT '{}',
  parse_source text NOT NULL DEFAULT 'heuristic',
  embedding    vector(1024),
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resumes_user_idx ON resumes (user_id, created_at DESC);
CREATE UNIQUE INDEX resumes_one_primary_idx ON resumes (user_id) WHERE is_primary;

CREATE TABLE resume_feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id  uuid NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  job_id     uuid REFERENCES jobs(id) ON DELETE SET NULL,
  score      integer NOT NULL,
  feedback   jsonb NOT NULL,
  source     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resume_feedback_resume_idx ON resume_feedback (resume_id, created_at DESC);

CREATE TABLE applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seeker_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_id      uuid REFERENCES resumes(id) ON DELETE SET NULL,
  cover_letter   text,
  status         text NOT NULL DEFAULT 'applied' CHECK (status IN
                   ('applied', 'shortlisted', 'scheduled', 'interviewed', 'recommended', 'selected', 'rejected', 'withdrawn')),
  match_score    integer,
  matched_skills text[] NOT NULL DEFAULT '{}',
  missing_skills text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, seeker_id)
);
CREATE INDEX applications_seeker_idx ON applications (seeker_id, created_at DESC);
CREATE INDEX applications_job_status_idx ON applications (job_id, status);

CREATE TABLE application_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status    text,
  to_status      text NOT NULL,
  changed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_events_app_idx ON application_events (application_id, created_at);
CREATE INDEX application_events_status_idx ON application_events (to_status, created_at);

CREATE TABLE interviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  scheduled_at     timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 45 CHECK (duration_minutes BETWEEN 5 AND 480),
  mode             text NOT NULL DEFAULT 'video' CHECK (mode IN ('video', 'phone', 'onsite')),
  interviewer      text,
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  rating           integer CHECK (rating BETWEEN 1 AND 5),
  feedback         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interviews_application_idx ON interviews (application_id);
CREATE INDEX interviews_scheduled_idx ON interviews (status, scheduled_at);
`,
  },
];
