/**
 * Demo data: three fictional companies, a dozen jobs and ~45 fictional candidates with
 * applications spread across the hiring pipeline, so the dashboard has something to show.
 * All names, companies and emails are made up (emails use the reserved .example domain).
 *
 *   npm run seed            # seed if the demo employer doesn't exist yet
 *   npm run seed -- --reset # delete demo accounts first, then seed again
 */
import bcrypt from "bcryptjs";
import { closeDb, connectDb, toVector, type Db } from "./index.js";
import { runMigrations } from "./migrate.js";
import { logger } from "../logger.js";
import { cosine, embed } from "../services/ai/embeddings.js";
import { heuristicParse, resumeEmbeddingText } from "../services/ai/resumeParser.js";
import { jobEmbeddingText, type JobInput } from "../services/jobs.service.js";
import { computeMatch } from "../services/matching.js";
import { PIPELINE_STAGES } from "../services/applications.service.js";
import { resumeKey, storage } from "../services/storage/index.js";

export const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "DemoPass123!";
export const DEMO_EMPLOYER_EMAIL = "employer@demo.example";
export const DEMO_SEEKER_EMAIL = "seeker@demo.example";
const DEMO_DOMAIN = "@demo.example";

// Deterministic PRNG so every seed run produces the same dataset.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261110);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const sample = <T>(xs: readonly T[], n: number): T[] => [...xs].sort(() => rand() - 0.5).slice(0, n);
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const DAY = 86_400_000;

type SeedJob = JobInput & { daysAgo: number };

const brightpathJobs: SeedJob[] = [
  {
    title: "Senior Frontend Developer",
    description: "Own the architecture of our customer-facing web app. You'll build fast, accessible interfaces in React and TypeScript, partner with design on our component library and mentor other engineers.",
    requirements: "5+ years building production React apps. Deep TypeScript knowledge. Experience with GraphQL, testing (Jest/Playwright) and web performance. System design experience is a plus.",
    skills: ["react", "typescript", "graphql", "css", "jest", "system design"],
    location: "San Francisco, CA", workMode: "hybrid", employmentType: "full_time", experienceLevel: "senior",
    salaryMin: 165000, salaryMax: 205000, currency: "USD", status: "open", daysAgo: 52,
  },
  {
    title: "Product Manager",
    description: "Drive the roadmap for our hiring analytics product. Talk to customers weekly, turn insights into clear specs and ship iteratively with a cross-functional squad.",
    requirements: "3+ years in B2B SaaS product management. Strong analytics skills (SQL a plus), experience running A/B tests and excellent stakeholder management.",
    skills: ["product management", "roadmapping", "analytics", "sql", "a/b testing", "stakeholder management"],
    location: "New York, NY", workMode: "hybrid", employmentType: "full_time", experienceLevel: "mid",
    salaryMin: 140000, salaryMax: 175000, currency: "USD", status: "open", daysAgo: 45,
  },
  {
    title: "Data Scientist",
    description: "Build the models behind candidate matching and recommendation. You'll work on embeddings, ranking and experimentation with a strong engineering team.",
    requirements: "Strong Python, statistics and machine learning. Experience with PyTorch or scikit-learn, embeddings / NLP, and putting models into production.",
    skills: ["python", "machine learning", "statistics", "pytorch", "natural language processing", "embeddings", "sql"],
    location: "Remote (US)", workMode: "remote", employmentType: "full_time", experienceLevel: "senior",
    salaryMin: 155000, salaryMax: 195000, currency: "USD", status: "open", daysAgo: 38,
  },
  {
    title: "DevOps Engineer",
    description: "Run and scale our AWS platform. Automate infrastructure with Terraform, operate Kubernetes clusters and keep our CI/CD fast and reliable.",
    requirements: "Hands-on AWS, Kubernetes, Terraform and Docker. Experience with observability (Prometheus/Grafana) and GitHub Actions. Linux and bash fluency.",
    skills: ["aws", "kubernetes", "terraform", "docker", "ci/cd", "prometheus", "linux"],
    location: "Austin, TX", workMode: "onsite", employmentType: "full_time", experienceLevel: "mid",
    salaryMin: 135000, salaryMax: 165000, currency: "USD", status: "open", daysAgo: 30,
  },
  {
    title: "Backend Engineer (Node.js)",
    description: "Design APIs and services that power job search for millions of seekers. Node.js, PostgreSQL and event-driven systems.",
    requirements: "3+ years with Node.js and TypeScript, PostgreSQL, REST/GraphQL API design, Redis and message queues (Kafka). Docker and AWS experience.",
    skills: ["node.js", "typescript", "postgresql", "rest", "redis", "kafka", "docker"],
    location: "Remote", workMode: "remote", employmentType: "full_time", experienceLevel: "mid",
    salaryMin: 130000, salaryMax: 170000, currency: "USD", status: "open", daysAgo: 20,
  },
  {
    title: "UX Designer",
    description: "Shape end-to-end experiences for recruiters and candidates, from research to polished Figma prototypes.",
    requirements: "Portfolio showing user research, interaction design and design systems work in Figma.",
    skills: ["figma", "ux", "ui", "user research"],
    location: "San Francisco, CA", workMode: "hybrid", employmentType: "contract", experienceLevel: "mid",
    salaryMin: 90000, salaryMax: 120000, currency: "USD", status: "closed", daysAgo: 80,
  },
];

const otherJobs: { company: string; jobs: SeedJob[] }[] = [
  {
    company: "Lumen Health",
    jobs: [
      {
        title: "Machine Learning Engineer",
        description: "Ship ML models that help clinicians triage patient messages. Own training pipelines, evaluation and deployment.",
        requirements: "Python, PyTorch, LLMs/NLP, MLOps on AWS. Experience with RAG and prompt engineering is a big plus.",
        skills: ["python", "pytorch", "llms", "natural language processing", "rag", "aws"],
        location: "Boston, MA", workMode: "hybrid", employmentType: "full_time", experienceLevel: "senior",
        salaryMin: 170000, salaryMax: 210000, currency: "USD", status: "open", daysAgo: 12,
      },
      {
        title: "Junior QA Automation Engineer",
        description: "Grow your career in test automation: write end-to-end tests and improve release quality for our patient app.",
        requirements: "Some experience with JavaScript or Python test frameworks (Cypress, Playwright or Selenium). Eagerness to learn CI/CD.",
        skills: ["javascript", "playwright", "cypress", "unit testing", "ci/cd"],
        location: "Remote", workMode: "remote", employmentType: "full_time", experienceLevel: "entry",
        salaryMin: 75000, salaryMax: 95000, currency: "USD", status: "open", daysAgo: 6,
      },
      {
        title: "Data Engineer",
        description: "Build reliable batch and streaming pipelines that feed analytics and ML across the company.",
        requirements: "SQL, Python, Spark, Airflow and dbt. Experience with Snowflake or BigQuery.",
        skills: ["sql", "python", "spark", "airflow", "dbt", "snowflake"],
        location: "Chicago, IL", workMode: "onsite", employmentType: "full_time", experienceLevel: "mid",
        salaryMin: 125000, salaryMax: 155000, currency: "USD", status: "open", daysAgo: 15,
      },
    ],
  },
  {
    company: "Orbital Commerce",
    jobs: [
      {
        title: "React Native Mobile Engineer",
        description: "Build our shopping app used by 3M customers on iOS and Android with React Native and TypeScript.",
        requirements: "Production React Native experience, TypeScript, REST/GraphQL, mobile performance profiling.",
        skills: ["react native", "typescript", "react", "graphql"],
        location: "London, UK", workMode: "hybrid", employmentType: "full_time", experienceLevel: "mid",
        salaryMin: 85000, salaryMax: 110000, currency: "GBP", status: "open", daysAgo: 9,
      },
      {
        title: "Full Stack Engineer (Contract)",
        description: "Six-month contract to build internal tools with Next.js, Node.js and PostgreSQL.",
        requirements: "Next.js, React, Node.js, PostgreSQL, Tailwind. Able to work independently.",
        skills: ["next.js", "react", "node.js", "postgresql", "tailwind"],
        location: "Remote", workMode: "remote", employmentType: "contract", experienceLevel: "mid",
        salaryMin: 110000, salaryMax: 140000, currency: "USD", status: "open", daysAgo: 4,
      },
      {
        title: "Engineering Manager, Platform",
        description: "Lead a team of 8 platform engineers. Balance delivery, reliability and people growth.",
        requirements: "5+ years engineering, 2+ years managing. Distributed systems, AWS, Kubernetes. Strong mentoring and communication.",
        skills: ["leadership", "mentoring", "distributed systems", "aws", "kubernetes", "communication"],
        location: "Berlin, Germany", workMode: "hybrid", employmentType: "full_time", experienceLevel: "lead",
        salaryMin: 120000, salaryMax: 150000, currency: "EUR", status: "open", daysAgo: 18,
      },
    ],
  },
];

const FIRST = ["Avery", "Jordan", "Riley", "Morgan", "Casey", "Taylor", "Quinn", "Rowan", "Skyler", "Emerson", "Hayden", "Parker", "Reese", "Sawyer", "Logan", "Kai", "Noor", "Arjun", "Mei", "Lena", "Mateo", "Sofia", "Ibrahim", "Priya", "Tomas", "Yara", "Elif", "Kenji", "Amara", "Dario"];
const LAST = ["Nakamura", "Okafor", "Lindqvist", "Moreau", "Castillo", "Haddad", "Novak", "Fischer", "Banerjee", "Kowalski", "Osei", "Duarte", "Sato", "Varga", "Ibarra", "Keller", "Mensah", "Rossi", "Andersen", "Petrov"];
const EMPLOYERS = ["Northbeam", "Quantia", "Bluefin Systems", "Cedar Analytics", "Helix Retail", "Pinnacle Cloud", "Waypoint Media", "Sunforge"];
const CITIES = ["Seattle, WA", "Austin, TX", "Denver, CO", "New York, NY", "Toronto, Canada", "San Francisco, CA", "Chicago, IL", "Remote"];

const ARCHETYPES = [
  { title: "Frontend Engineer", core: ["react", "typescript", "javascript", "css", "html"], extra: ["graphql", "jest", "next.js", "redux", "tailwind", "playwright", "webpack", "figma"] },
  { title: "Backend Engineer", core: ["node.js", "typescript", "postgresql", "rest"], extra: ["redis", "kafka", "docker", "aws", "graphql", "microservices", "python", "go"] },
  { title: "Data Scientist", core: ["python", "machine learning", "statistics", "sql"], extra: ["pytorch", "scikit-learn", "pandas", "natural language processing", "embeddings", "tableau", "spark"] },
  { title: "DevOps Engineer", core: ["aws", "docker", "linux", "ci/cd"], extra: ["kubernetes", "terraform", "prometheus", "grafana", "bash", "github actions", "python"] },
  { title: "Product Manager", core: ["product management", "roadmapping", "stakeholder management"], extra: ["analytics", "sql", "a/b testing", "agile", "jira", "user research", "figma"] },
  { title: "Full Stack Developer", core: ["javascript", "react", "node.js"], extra: ["typescript", "postgresql", "next.js", "mongodb", "docker", "tailwind", "aws"] },
];

function resumeText(name: string, archetype: (typeof ARCHETYPES)[number], years: number, skills: string[]) {
  const city = pick(CITIES);
  const now = new Date().getFullYear();
  const jobs = sample(EMPLOYERS, 2);
  const firstEnd = now - between(0, 1);
  const metric = () => pick(["35%", "2x", "40%", "120k users", "25%", "$1.2M", "60%"]);
  return `${name}
${years > 6 ? "Senior " : ""}${archetype.title}
${city}

Summary
${archetype.title} with ${years} years of experience delivering reliable products with ${skills.slice(0, 3).join(", ")}. Known for shipping quickly and collaborating closely with design and product.

Experience
${years > 6 ? "Senior " : ""}${archetype.title} at ${jobs[0]} (${firstEnd - Math.min(years, 4)} - present)
- Led a project using ${skills[0]} and ${skills[1] ?? skills[0]} that improved conversion by ${metric()}
- Built and maintained services handling ${metric()} with ${skills[2] ?? skills[0]}
- Mentored 3 engineers and introduced code review guidelines
${archetype.title} at ${jobs[1]} (${firstEnd - years} - ${firstEnd - Math.min(years, 4)})
- Developed features with ${skills.slice(3, 6).join(", ") || skills[0]} used by ${metric()}
- Reduced costs by ${metric()} through automation

Education
${pick(["State University", "Lakeside Institute of Technology", "Riverside College"])}, ${pick(["B.S. in Computer Science", "B.A. in Economics", "M.S. in Data Science", "B.Tech in Information Technology"])}, ${firstEnd - years - 1}

Skills
${skills.join(", ")}
`;
}

async function seed(db: Db, reset: boolean) {
  const existing = await db.query("SELECT 1 FROM users WHERE email = $1", [DEMO_EMPLOYER_EMAIL]);
  if (existing.rowCount && !reset) {
    logger.info("Demo data already present (use --reset to recreate)");
    return;
  }
  if (reset) {
    const { rowCount } = await db.query("DELETE FROM users WHERE email LIKE $1", [`%${DEMO_DOMAIN}`]);
    logger.info({ deleted: rowCount }, "Removed existing demo accounts");
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const now = Date.now();

  async function createUser(email: string, fullName: string, role: "seeker" | "employer", createdAt = new Date(now - 90 * DAY)) {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [email, passwordHash, fullName, role, createdAt],
    );
    return rows[0]!.id;
  }

  // ---- companies + jobs
  const employers: { userId: string; companyId: string; jobs: SeedJob[] }[] = [];
  const mainEmployer = await createUser(DEMO_EMPLOYER_EMAIL, "Jamie Calloway", "employer");
  const mainCompany = (
    await db.query<{ id: string }>(
      "INSERT INTO companies (owner_id, name, website, industry, size, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [mainEmployer, "Brightpath Labs", "https://brightpath.example", "HR Technology", "51-200", "We build hiring software that helps teams find great people faster."],
    )
  ).rows[0]!.id;
  employers.push({ userId: mainEmployer, companyId: mainCompany, jobs: brightpathJobs });
  for (const [i, other] of otherJobs.entries()) {
    const uid = await createUser(`talent${i + 1}${DEMO_DOMAIN}`, `${pick(FIRST)} ${pick(LAST)}`, "employer");
    const cid = (await db.query<{ id: string }>("INSERT INTO companies (owner_id, name) VALUES ($1,$2) RETURNING id", [uid, other.company])).rows[0]!.id;
    employers.push({ userId: uid, companyId: cid, jobs: other.jobs });
  }

  const allJobs = employers.flatMap((e) => e.jobs.map((j) => ({ ...j, employer: e })));
  const jobVectors = await embed(allJobs.map((j) => jobEmbeddingText(j)), "document");
  const jobIds: string[] = [];
  for (const [i, j] of allJobs.entries()) {
    const created = new Date(now - j.daysAgo * DAY);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO jobs (company_id, posted_by, title, description, requirements, skills, location, work_mode, employment_type,
         experience_level, salary_min, salary_max, currency, status, embedding, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector,$16,$16) RETURNING id`,
      [j.employer.companyId, j.employer.userId, j.title, j.description, j.requirements, j.skills, j.location, j.workMode, j.employmentType,
        j.experienceLevel, j.salaryMin, j.salaryMax, j.currency, j.status, toVector(jobVectors[i]), created],
    );
    jobIds.push(rows[0]!.id);
  }

  // ---- seekers + resumes
  const seekers: { id: string; resumeId: string; skills: string[]; vector: number[] | null; archetype: number }[] = [];
  const people = Array.from({ length: 45 }, (_, i) => {
    const archetype = i === 0 ? 0 : between(0, ARCHETYPES.length - 1);
    const a = ARCHETYPES[archetype]!;
    const skills = [...a.core, ...sample(a.extra, between(1, a.extra.length - 1))];
    const years = between(1, 12);
    const name = i === 0 ? "Alex Morgan" : `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    return { name, archetype, text: resumeText(name, a, years, skills), email: i === 0 ? DEMO_SEEKER_EMAIL : `candidate${i}${DEMO_DOMAIN}` };
  });
  const parsedList = people.map((p) => heuristicParse(p.text));
  const resumeVectors = await embed(parsedList.map((parsed, i) => resumeEmbeddingText(parsed, people[i]!.text)), "document");

  for (const [i, person] of people.entries()) {
    const userId = await createUser(person.email, person.name, "seeker", new Date(now - between(20, 80) * DAY));
    const parsed = parsedList[i]!;
    const key = resumeKey(userId, "resume.txt");
    await storage().put(key, Buffer.from(person.text), "text/plain");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO resumes (user_id, file_key, file_name, mime_type, size_bytes, raw_text, parsed, skills, parse_source, embedding, is_primary)
       VALUES ($1,$2,$3,'text/plain',$4,$5,$6::jsonb,$7,'heuristic',$8::vector,true) RETURNING id`,
      [userId, key, `${person.name.replace(/\s+/g, "_")}_Resume.txt`, Buffer.byteLength(person.text), person.text, JSON.stringify(parsed), parsed.skills, toVector(resumeVectors[i])],
    );
    seekers.push({ id: userId, resumeId: rows[0]!.id, skills: parsed.skills, vector: resumeVectors[i] ?? null, archetype: person.archetype });
  }

  // ---- applications with realistic stage history (the demo seeker is left with a couple of open applications only)
  const statusFlow = (r: number) =>
    r < 0.2 ? "applied" : r < 0.38 ? "shortlisted" : r < 0.52 ? "scheduled" : r < 0.66 ? "interviewed" : r < 0.75 ? "recommended" : r < 0.82 ? "selected" : "rejected";
  const interviewers = ["Jamie Calloway", "Sam Whitaker", "Dana Okoro"];
  let applications = 0;
  let interviewsCreated = 0;

  for (const s of seekers) {
    const preferred = allJobs
      .map((j, idx) => ({ idx, score: computeMatch({ candidateSkills: s.skills, jobSkills: j.skills, similarity: s.vector && jobVectors[idx] ? cosine(s.vector, jobVectors[idx]!) : null }).score, job: j }))
      .sort((a, b) => b.score - a.score);
    const isDemoSeeker = s === seekers[0];
    const targets = isDemoSeeker ? preferred.filter((p) => p.job.employer.companyId === mainCompany).slice(1, 3) : preferred.slice(0, between(2, 4));

    for (const t of targets) {
      const job = t.job;
      if (job.status === "draft") continue;
      const appliedDaysAgo = Math.max(0.5, rand() * Math.min(job.daysAgo, 58));
      const appliedAt = new Date(now - appliedDaysAgo * DAY);
      const final = isDemoSeeker ? pick(["applied", "shortlisted"]) : statusFlow(rand());
      const match = computeMatch({ candidateSkills: s.skills, jobSkills: job.skills, similarity: s.vector && jobVectors[t.idx] ? cosine(s.vector, jobVectors[t.idx]!) : null });

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO applications (job_id, seeker_id, resume_id, status, match_score, matched_skills, missing_skills, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
        [jobIds[t.idx], s.id, s.resumeId, final, match.score, match.matched, match.missing, appliedAt],
      );
      const appId = rows[0]!.id;
      applications++;

      // Walk the pipeline up to the final stage, spacing events over the elapsed time.
      const finalIdx = final === "rejected" ? between(0, 3) : PIPELINE_STAGES.indexOf(final as (typeof PIPELINE_STAGES)[number]);
      const steps = [...PIPELINE_STAGES.slice(0, finalIdx + 1), ...(final === "rejected" ? ["rejected"] : [])];
      const stepMs = (now - appliedAt.getTime()) / (steps.length + 1);
      let prev: string | null = null;
      for (const [k, step] of steps.entries()) {
        const at = new Date(appliedAt.getTime() + k * stepMs);
        await db.query(
          "INSERT INTO application_events (application_id, from_status, to_status, changed_by, created_at) VALUES ($1,$2,$3,$4,$5)",
          [appId, prev, step, k === 0 ? s.id : job.employer.userId, at],
        );
        prev = step;
      }

      // Interviews for candidates who reached the scheduled stage.
      const reachedScheduled = steps.includes("scheduled");
      if (reachedScheduled && job.employer.companyId === mainCompany) {
        const scheduledEvent = appliedAt.getTime() + steps.indexOf("scheduled") * stepMs;
        const isUpcoming = final === "scheduled";
        const at = isUpcoming
          ? new Date(now + between(1, 6) * DAY + between(9, 16) * 3_600_000)
          : new Date(Math.min(now - 3_600_000, scheduledEvent + between(1, 4) * DAY));
        at.setUTCMinutes(isUpcoming ? pick([0, 30]) : 0, 0, 0);
        const duration = pick([30, 45, 45, 60]);
        const pendingReview = !isUpcoming && rand() < 0.15;
        await db.query(
          `INSERT INTO interviews (application_id, scheduled_at, duration_minutes, mode, interviewer, status, rating, feedback, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            appId, at, duration, pick(["video", "video", "onsite", "phone"]), pick(interviewers),
            isUpcoming || pendingReview ? "scheduled" : "completed",
            isUpcoming || pendingReview ? null : between(2, 5),
            isUpcoming || pendingReview ? null : pick(["Strong fundamentals, clear communicator.", "Good problem solving; needs depth in system design.", "Great culture add, solid technical answers."]),
            new Date(scheduledEvent),
          ],
        );
        interviewsCreated++;
      }
    }
  }

  // Two deliberately overlapping interviews so "Find scheduling conflicts" has something to find.
  const { rows: upcoming } = await db.query<{ id: string; scheduled_at: Date }>(
    `SELECT i.id, i.scheduled_at FROM interviews i JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id
     WHERE j.company_id = $1 AND i.status = 'scheduled' AND i.scheduled_at > now() ORDER BY i.scheduled_at LIMIT 2`,
    [mainCompany],
  );
  if (upcoming.length === 2) {
    await db.query("UPDATE interviews SET interviewer = 'Jamie Calloway', scheduled_at = $2 WHERE id = $1", [upcoming[0]!.id, upcoming[0]!.scheduled_at]);
    await db.query("UPDATE interviews SET interviewer = 'Jamie Calloway', scheduled_at = $2 WHERE id = $1", [
      upcoming[1]!.id,
      new Date(new Date(upcoming[0]!.scheduled_at).getTime() + 15 * 60_000),
    ]);
  }

  logger.info(
    { jobs: jobIds.length, seekers: seekers.length, applications, interviews: interviewsCreated },
    `Seeded demo data. Log in as ${DEMO_EMPLOYER_EMAIL} or ${DEMO_SEEKER_EMAIL} (password: SEED_DEMO_PASSWORD, see .env.example)`,
  );
}

const db = await connectDb();
try {
  await runMigrations(db);
  await seed(db, process.argv.includes("--reset"));
} finally {
  await closeDb();
}
