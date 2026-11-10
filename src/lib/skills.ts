/**
 * Skill vocabulary + normalisation shared by resume parsing, job matching and search.
 * Claude extracts skills freely when configured; this list powers the offline heuristic
 * engine and keeps skill names consistent ("JS" and "javascript" compare equal).
 */

const ALIASES: Record<string, string> = {
  js: "javascript",
  "ecmascript": "javascript",
  ts: "typescript",
  "react.js": "react",
  reactjs: "react",
  "react native": "react native",
  "vue.js": "vue",
  vuejs: "vue",
  "angular.js": "angular",
  angularjs: "angular",
  node: "node.js",
  nodejs: "node.js",
  "express.js": "express",
  expressjs: "express",
  "next.js": "next.js",
  nextjs: "next.js",
  postgres: "postgresql",
  psql: "postgresql",
  mongo: "mongodb",
  k8s: "kubernetes",
  "amazon web services": "aws",
  gcp: "google cloud",
  "google cloud platform": "google cloud",
  "ms azure": "azure",
  golang: "go",
  "c sharp": "c#",
  csharp: "c#",
  "c plus plus": "c++",
  cpp: "c++",
  py: "python",
  "scikit learn": "scikit-learn",
  sklearn: "scikit-learn",
  "tensor flow": "tensorflow",
  "machine-learning": "machine learning",
  ml: "machine learning",
  "deep-learning": "deep learning",
  nlp: "natural language processing",
  llm: "llms",
  "large language models": "llms",
  "ci cd": "ci/cd",
  cicd: "ci/cd",
  "github action": "github actions",
  tf: "terraform",
  "rest api": "rest",
  "restful": "rest",
  "rest apis": "rest",
  gql: "graphql",
  "ux design": "ux",
  "ui design": "ui",
  "product mgmt": "product management",
  "a/b test": "a/b testing",
  sql: "sql",
};

export const SKILL_VOCABULARY: string[] = [
  // languages
  "javascript", "typescript", "python", "java", "go", "rust", "c#", "c++", "ruby", "php", "kotlin", "swift", "scala", "sql", "r",
  // frontend
  "react", "react native", "vue", "angular", "svelte", "next.js", "redux", "html", "css", "tailwind", "sass", "webpack", "vite",
  // backend
  "node.js", "express", "nestjs", "django", "flask", "fastapi", "spring boot", "rails", ".net", "graphql", "rest", "grpc", "microservices",
  // data
  "postgresql", "mysql", "mongodb", "redis", "elasticsearch", "kafka", "rabbitmq", "dynamodb", "snowflake", "bigquery", "spark", "airflow", "dbt", "pandas", "numpy",
  // ml / ai
  "machine learning", "deep learning", "natural language processing", "computer vision", "pytorch", "tensorflow", "scikit-learn", "llms", "embeddings", "rag", "prompt engineering", "statistics", "data analysis", "data visualization", "tableau", "power bi",
  // cloud / devops
  "aws", "azure", "google cloud", "docker", "kubernetes", "terraform", "ansible", "ci/cd", "github actions", "jenkins", "linux", "bash", "prometheus", "grafana", "observability", "system design", "distributed systems", "security",
  // testing
  "jest", "vitest", "cypress", "playwright", "selenium", "unit testing", "tdd",
  // product / design / business
  "product management", "roadmapping", "agile", "scrum", "jira", "figma", "ux", "ui", "user research", "a/b testing", "analytics", "seo", "marketing", "sales", "stakeholder management", "communication", "leadership", "mentoring", "project management",
];

const VOCAB_SET = new Set(SKILL_VOCABULARY);

export function normalizeSkill(raw: string): string {
  const s = raw.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
  return ALIASES[s] ?? s;
}

export function normalizeSkills(raw: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const n = normalizeSkill(r);
    if (n && n.length <= 60) out.add(n);
  }
  return [...out];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/#]/g, "\\$&");
}

const SKILL_PATTERNS: { skill: string; re: RegExp }[] = [
  ...SKILL_VOCABULARY.filter((s) => s !== "r" && s !== "go").map((skill) => ({
    skill,
    re: new RegExp(`(^|[^a-z0-9+#])${escapeRegex(skill)}($|[^a-z0-9+#])`, "i"),
  })),
  ...Object.entries(ALIASES)
    .filter(([alias]) => alias.length > 2)
    .map(([alias, skill]) => ({ skill, re: new RegExp(`(^|[^a-z0-9+#])${escapeRegex(alias)}($|[^a-z0-9+#])`, "i") })),
  // short, ambiguous names only count with a strong signal next to them
  { skill: "go", re: /\b(golang|go \(golang\)|go,\s|go\/|in go\b|go developer|go engineer)/i },
  { skill: "r", re: /\b(r programming|rstudio|\br,\s*python|python,\s*r\b)/i },
];

/** Finds known skills mentioned in free text. */
export function extractSkills(text: string): string[] {
  const found = new Set<string>();
  for (const { skill, re } of SKILL_PATTERNS) {
    if (re.test(text)) found.add(skill);
  }
  return [...found];
}

export function isKnownSkill(skill: string): boolean {
  return VOCAB_SET.has(normalizeSkill(skill));
}

/** Compare candidate skills against required skills. */
export function compareSkills(candidate: string[], required: string[]) {
  const have = new Set(normalizeSkills(candidate));
  const req = normalizeSkills(required);
  const matched = req.filter((s) => have.has(s));
  const missing = req.filter((s) => !have.has(s));
  const coverage = req.length ? matched.length / req.length : 0;
  return { matched, missing, coverage };
}
