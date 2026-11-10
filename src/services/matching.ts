import { compareSkills } from "../lib/skills.js";
import { semanticScore } from "./ai/embeddings.js";

/**
 * Candidate <-> job match score (0-100): a blend of required-skill coverage and the
 * embedding similarity between resume and job description.
 */
export function computeMatch(input: { candidateSkills: string[]; jobSkills: string[]; similarity: number | null }) {
  const { matched, missing, coverage } = compareSkills(input.candidateSkills, input.jobSkills);
  const semantic = semanticScore(input.similarity);
  const hasSkills = input.jobSkills.length > 0;
  const hasSemantic = input.similarity != null;
  let score: number;
  if (hasSkills && hasSemantic) score = 0.6 * coverage + 0.4 * semantic;
  else if (hasSkills) score = coverage;
  else score = semantic;
  return { score: Math.round(score * 100), matched, missing, coverage, semantic };
}
