import { describe, expect, it } from "vitest";
import { compareSkills, extractSkills, normalizeSkill } from "../src/lib/skills.js";
import { cosine, localEmbedding } from "../src/services/ai/embeddings.js";
import { heuristicSearchIntent } from "../src/services/ai/querySearch.js";
import { estimateYears, heuristicParse } from "../src/services/ai/resumeParser.js";
import { heuristicFeedback } from "../src/services/ai/resumeFeedback.js";
import { computeMatch } from "../src/services/matching.js";

describe("skills", () => {
  it("normalises aliases", () => {
    expect(normalizeSkill(" ReactJS ")).toBe("react");
    expect(normalizeSkill("K8s")).toBe("kubernetes");
    expect(normalizeSkill("Postgres")).toBe("postgresql");
  });

  it("extracts skills without false positives on short words", () => {
    const skills = extractSkills("Built services in Node.js and TypeScript on AWS with Docker; I will go to the office.");
    expect(skills).toEqual(expect.arrayContaining(["node.js", "typescript", "aws", "docker"]));
    expect(skills).not.toContain("go");
    expect(extractSkills("Backend in Golang and C++")).toEqual(expect.arrayContaining(["go", "c++"]));
  });

  it("compares candidate vs required skills", () => {
    expect(compareSkills(["React", "JS"], ["react", "javascript", "graphql"])).toEqual({
      matched: ["react", "javascript"],
      missing: ["graphql"],
      coverage: 2 / 3,
    });
  });
});

describe("local embeddings", () => {
  it("places related texts closer than unrelated ones", () => {
    const frontend = localEmbedding("Senior React developer building TypeScript user interfaces");
    const similar = localEmbedding("Frontend engineer with React, TypeScript and CSS experience");
    const unrelated = localEmbedding("Registered nurse for night shifts in a hospital ward");
    expect(frontend).toHaveLength(1024);
    expect(cosine(frontend, similar)).toBeGreaterThan(cosine(frontend, unrelated) + 0.2);
  });

  it("feeds a 0-100 match score", () => {
    const m = computeMatch({ candidateSkills: ["react", "typescript"], jobSkills: ["react", "typescript", "graphql", "jest"], similarity: 0.5 });
    expect(m.matched).toEqual(["react", "typescript"]);
    expect(m.score).toBeGreaterThan(40);
    expect(m.score).toBeLessThan(80);
  });
});

describe("natural-language search parsing", () => {
  it.each([
    ["remote senior python jobs over $150k", { workMode: "remote", experienceLevel: "senior", salaryMin: 150000, location: null }],
    ["entry level data analyst internship in Chicago", { experienceLevel: "entry", employmentType: "internship", location: "Chicago" }],
    ["hybrid product manager roles near San Francisco", { workMode: "hybrid", location: "San Francisco" }],
    ["part-time ux designer", { employmentType: "part_time", workMode: null }],
  ])("%s", (query, expected) => {
    expect(heuristicSearchIntent(query)).toMatchObject(expected);
  });

  it("keeps the role description for semantic matching", () => {
    expect(heuristicSearchIntent("Find me remote React jobs paying 120k").semanticQuery).toBe("React");
  });
});

describe("resume heuristics", () => {
  const text = `Jane Example
Data Engineer
Chicago, IL

Summary
Data engineer with 5 years of experience.

Experience
Data Engineer at Fictional Freight (2020 - present)
- Built Spark pipelines processing 2TB per day
- Reduced warehouse costs by 30%

Education
Lakeside College, B.S. in Mathematics, 2019

Skills
Python, SQL, Spark, Airflow, dbt`;

  it("parses sections", () => {
    const p = heuristicParse(text);
    expect(p).toMatchObject({ fullName: "Jane Example", headline: "Data Engineer", location: "Chicago, IL" });
    expect(p.skills).toEqual(expect.arrayContaining(["python", "sql", "spark", "airflow", "dbt"]));
    expect(p.experience[0]).toMatchObject({ title: "Data Engineer", company: "Fictional Freight", startDate: "2020" });
    expect(p.education[0]).toMatchObject({ institution: "Lakeside College", graduationYear: 2019 });
  });

  it("estimates years of experience from text and date ranges", () => {
    expect(estimateYears("Engineer (2015 - 2019), Lead (2019 - 2023)")).toBe(8);
    expect(estimateYears("Over 10+ years building software")).toBe(10);
  });

  it("produces actionable feedback", () => {
    const fb = heuristicFeedback(text, heuristicParse(text), null);
    expect(fb.overallScore).toBeGreaterThan(0);
    expect(fb.improvements.map((i) => i.area)).toContain("Add links");
    expect(fb.jobFit).toBeNull();
  });
});
