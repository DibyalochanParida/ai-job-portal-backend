import { query } from "../db/index.js";
import { DROPPED_STATUSES, PIPELINE_STAGES, stageIndex } from "./applications.service.js";

const DAY = 86_400_000;
const BUCKETS = 8;

interface AppRow {
  id: string;
  jobId: string;
  status: string;
  matchScore: number | null;
  missingSkills: string[];
  createdAt: Date;
}
interface EventRow {
  applicationId: string;
  toStatus: string;
  createdAt: Date;
}
interface InterviewRow {
  id: string;
  applicationId: string;
  scheduledAt: Date;
  durationMinutes: number;
  status: string;
  candidateName: string;
  jobTitle: string;
  interviewer: string | null;
  mode: string;
}
interface JobRow {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
}

export interface Kpi {
  value: number;
  delta: number | null;
  deltaUnit: "percent" | "points" | "count";
  series: number[];
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const pctChange = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? 0 : null) : round(((cur - prev) / prev) * 100));
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Highest forward stage each application ever reached (from its status history). */
function furthestStages(apps: AppRow[], events: EventRow[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const a of apps) best.set(a.id, stageIndex(a.status));
  for (const e of events) {
    const i = stageIndex(e.toStatus);
    if (i > (best.get(e.applicationId) ?? -1)) best.set(e.applicationId, i);
  }
  return best;
}

function reachedCounts(cohort: AppRow[], furthest: Map<string, number>): number[] {
  return PIPELINE_STAGES.map((_, i) => cohort.filter((a) => (furthest.get(a.id) ?? 0) >= i).length);
}

export async function getEmployerAnalytics(companyId: string, days: number, now = new Date()) {
  const from = new Date(now.getTime() - days * DAY);
  const prevFrom = new Date(now.getTime() - 2 * days * DAY);
  const bucketMs = (days * DAY) / BUCKETS;
  const bucketOf = (d: Date) => Math.floor((d.getTime() - from.getTime()) / bucketMs);

  const [jobs, apps, events, interviews] = await Promise.all([
    query<JobRow>(`SELECT id, title, status, created_at AS "createdAt" FROM jobs WHERE company_id = $1`, [companyId]),
    query<AppRow>(
      `SELECT a.id, a.job_id AS "jobId", a.status, a.match_score AS "matchScore", a.missing_skills AS "missingSkills", a.created_at AS "createdAt"
       FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.company_id = $1`,
      [companyId],
    ),
    query<EventRow>(
      `SELECT e.application_id AS "applicationId", e.to_status AS "toStatus", e.created_at AS "createdAt"
       FROM application_events e JOIN applications a ON a.id = e.application_id JOIN jobs j ON j.id = a.job_id
       WHERE j.company_id = $1`,
      [companyId],
    ),
    query<InterviewRow>(
      `SELECT i.id, i.application_id AS "applicationId", i.scheduled_at AS "scheduledAt", i.duration_minutes AS "durationMinutes",
              i.status, i.interviewer, i.mode, u.full_name AS "candidateName", j.title AS "jobTitle"
       FROM interviews i JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.seeker_id
       WHERE j.company_id = $1`,
      [companyId],
    ),
  ]).then((r) => r.map((x) => x.rows)) as [JobRow[], AppRow[], EventRow[], InterviewRow[]];

  const inWindow = (d: Date) => d >= from && d <= now;
  const inPrev = (d: Date) => d >= prevFrom && d < from;
  const cohort = apps.filter((a) => inWindow(a.createdAt));
  const prevCohort = apps.filter((a) => inPrev(a.createdAt));
  const furthest = furthestStages(apps, events);

  // ---- KPI: candidates
  const candSeries = new Array<number>(BUCKETS).fill(0);
  for (const a of cohort) candSeries[Math.min(BUCKETS - 1, bucketOf(a.createdAt))]!++;

  // ---- KPI: average interview length (completed interviews)
  const completed = interviews.filter((i) => i.status === "completed");
  const curInterviews = completed.filter((i) => inWindow(i.scheduledAt));
  const prevInterviews = completed.filter((i) => inPrev(i.scheduledAt));
  const interviewSeries = Array.from({ length: BUCKETS }, (_, b) =>
    round(avg(curInterviews.filter((i) => bucketOf(i.scheduledAt) === b).map((i) => i.durationMinutes)), 0),
  );
  const curInterviewAvg = round(avg(curInterviews.map((i) => i.durationMinutes)), 0);
  const prevInterviewAvg = round(avg(prevInterviews.map((i) => i.durationMinutes)), 0);

  // ---- KPI: offer rate = interviewed candidates who reached recommended/selected
  const offerRate = (group: AppRow[]) => {
    const interviewed = group.filter((a) => (furthest.get(a.id) ?? 0) >= stageIndex("interviewed"));
    const offered = interviewed.filter((a) => (furthest.get(a.id) ?? 0) >= stageIndex("recommended"));
    return interviewed.length ? (offered.length / interviewed.length) * 100 : 0;
  };
  const hireSeries = Array.from({ length: BUCKETS }, (_, b) => round(offerRate(cohort.filter((a) => bucketOf(a.createdAt) === b)), 0));

  // ---- KPI: active jobs
  const openJobs = jobs.filter((j) => j.status === "open");
  const jobsPostedInWindow = jobs.filter((j) => inWindow(j.createdAt)).length;
  const jobSeries = Array.from({ length: BUCKETS }, (_, b) =>
    jobs.filter((j) => j.status !== "draft" && j.createdAt.getTime() <= from.getTime() + (b + 1) * bucketMs).length,
  );

  // ---- Pipeline (current status of this period's cohort)
  const stageCounts = PIPELINE_STAGES.map((stage) => ({ key: stage, count: cohort.filter((a) => a.status === stage).length }));
  const dropped = cohort.filter((a) => (DROPPED_STATUSES as readonly string[]).includes(a.status)).length;

  const reached = reachedCounts(cohort, furthest);
  const prevReached = reachedCounts(prevCohort, furthest);
  const conversions = [1, 2, 3, 4].map((i) => ({
    from: PIPELINE_STAGES[i]!,
    to: PIPELINE_STAGES[i + 1]!,
    rate: reached[i] ? round((reached[i + 1]! / reached[i]!) * 100, 0) : null,
    previousRate: prevReached[i] ? round((prevReached[i + 1]! / prevReached[i]!) * 100, 0) : null,
  }));

  // ---- AI match quality (all applications to currently open jobs)
  const openIds = new Set(openJobs.map((j) => j.id));
  const openApps = apps.filter((a) => openIds.has(a.jobId));
  const scored = (xs: AppRow[]) => xs.filter((a) => a.matchScore != null).map((a) => a.matchScore!);
  const perJob = openJobs
    .map((j) => {
      const s = scored(openApps.filter((a) => a.jobId === j.id));
      return { jobId: j.id, title: j.title, applicants: s.length, score: s.length ? round(avg(s), 0) : null };
    })
    .filter((j) => j.applicants > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const curMatch = avg(scored(cohort));
  const prevMatch = avg(scored(prevCohort));

  const missingCounts = new Map<string, number>();
  for (const a of openApps) for (const s of a.missingSkills) missingCounts.set(s, (missingCounts.get(s) ?? 0) + 1);
  const topMissingSkills = [...missingCounts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([skill, n]) => ({ skill, percent: round((n / openApps.length) * 100, 0), count: n }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const upcomingInterviews = interviews
    .filter((i) => i.status === "scheduled" && i.scheduledAt >= now)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .slice(0, 5)
    .map(({ id, scheduledAt, durationMinutes, candidateName, jobTitle, mode, interviewer }) => ({
      id, scheduledAt, durationMinutes, candidateName, jobTitle, mode, interviewer,
    }));

  const kpis: Record<"totalCandidates" | "interviewTime" | "hireRate" | "activeJobs", Kpi> = {
    totalCandidates: { value: cohort.length, delta: pctChange(cohort.length, prevCohort.length), deltaUnit: "percent", series: candSeries },
    interviewTime: { value: curInterviewAvg, delta: curInterviews.length && prevInterviews.length ? pctChange(curInterviewAvg, prevInterviewAvg) : null, deltaUnit: "percent", series: interviewSeries },
    hireRate: { value: round(offerRate(cohort), 0), delta: round(offerRate(cohort) - offerRate(prevCohort), 1), deltaUnit: "points", series: hireSeries },
    activeJobs: { value: openJobs.length, delta: jobsPostedInWindow, deltaUnit: "count", series: jobSeries },
  };

  return {
    period: { days, from, to: now },
    kpis,
    pipeline: {
      total: cohort.length,
      stages: [...stageCounts, { key: "dropped", count: dropped }],
      conversions,
    },
    matchQuality: {
      overall: openApps.length ? round(avg(scored(openApps)), 0) : null,
      delta: prevCohort.length && cohort.length ? round(curMatch - prevMatch, 0) : null,
      jobs: perJob.slice(0, 6),
      topMissingSkills,
    },
    upcomingInterviews,
  };
}

export type EmployerAnalytics = Awaited<ReturnType<typeof getEmployerAnalytics>>;

// ------------------------------------------------------------------ assistant data access

export async function topCandidates(companyId: string, opts: { jobId?: string | null; limit?: number } = {}) {
  const params: unknown[] = [companyId, Math.min(opts.limit ?? 5, 20)];
  if (opts.jobId) params.push(opts.jobId);
  const { rows } = await query<{
    applicationId: string;
    candidateName: string;
    jobTitle: string;
    status: string;
    matchScore: number | null;
    matchedSkills: string[];
    missingSkills: string[];
    headline: string | null;
    years: number | null;
  }>(
    `SELECT a.id AS "applicationId", u.full_name AS "candidateName", j.title AS "jobTitle", a.status,
            a.match_score AS "matchScore", a.matched_skills AS "matchedSkills", a.missing_skills AS "missingSkills",
            r.parsed->>'headline' AS headline, (r.parsed->>'totalYearsExperience')::float8 AS years
     FROM applications a JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.seeker_id LEFT JOIN resumes r ON r.id = a.resume_id
     WHERE j.company_id = $1 AND a.status NOT IN ('rejected', 'withdrawn', 'selected') ${opts.jobId ? "AND j.id = $3" : ""}
     ORDER BY a.match_score DESC NULLS LAST, a.created_at DESC
     LIMIT $2`,
    params,
  );
  return rows;
}

export async function pendingInterviewReviews(companyId: string, now = new Date()) {
  const { rows } = await query<{
    interviewId: string;
    candidateName: string;
    jobTitle: string;
    scheduledAt: Date;
    status: string;
    interviewer: string | null;
  }>(
    `SELECT i.id AS "interviewId", u.full_name AS "candidateName", j.title AS "jobTitle", i.scheduled_at AS "scheduledAt",
            i.status, i.interviewer
     FROM interviews i JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.seeker_id
     WHERE j.company_id = $1
       AND ((i.status = 'scheduled' AND i.scheduled_at + make_interval(mins => i.duration_minutes) < $2)
            OR (i.status = 'completed' AND (i.feedback IS NULL OR i.rating IS NULL)))
     ORDER BY i.scheduled_at`,
    [companyId, now],
  );
  return rows;
}

export async function schedulingConflicts(companyId: string, now = new Date()) {
  const { rows } = await query<{
    interviewId: string;
    candidateName: string;
    jobTitle: string;
    scheduledAt: Date;
    durationMinutes: number;
    interviewer: string | null;
  }>(
    `SELECT i.id AS "interviewId", u.full_name AS "candidateName", j.title AS "jobTitle", i.scheduled_at AS "scheduledAt",
            i.duration_minutes AS "durationMinutes", i.interviewer
     FROM interviews i JOIN applications a ON a.id = i.application_id JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.seeker_id
     WHERE j.company_id = $1 AND i.status = 'scheduled' AND i.scheduled_at >= $2
     ORDER BY i.scheduled_at`,
    [companyId, now],
  );
  const conflicts: { interviewer: string; first: (typeof rows)[number]; second: (typeof rows)[number]; overlapMinutes: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let k = i + 1; k < rows.length; k++) {
      const a = rows[i]!;
      const b = rows[k]!;
      const sameOwner = (a.interviewer ?? "hiring team").toLowerCase() === (b.interviewer ?? "hiring team").toLowerCase();
      if (!sameOwner) continue;
      const aEnd = a.scheduledAt.getTime() + a.durationMinutes * 60_000;
      const overlap = Math.min(aEnd, b.scheduledAt.getTime() + b.durationMinutes * 60_000) - b.scheduledAt.getTime();
      if (b.scheduledAt.getTime() < aEnd && overlap > 0) {
        conflicts.push({ interviewer: a.interviewer ?? "hiring team", first: a, second: b, overlapMinutes: Math.round(overlap / 60_000) });
      }
    }
  }
  return { upcomingCount: rows.length, conflicts };
}

export async function jobsOverview(companyId: string) {
  const { rows } = await query<{ jobId: string; title: string; status: string; applicants: number; avgMatch: number | null; createdAt: Date }>(
    `SELECT j.id AS "jobId", j.title, j.status, count(a.id)::int AS applicants, round(avg(a.match_score))::int AS "avgMatch", j.created_at AS "createdAt"
     FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
     WHERE j.company_id = $1 GROUP BY j.id ORDER BY j.created_at DESC`,
    [companyId],
  );
  return rows;
}
