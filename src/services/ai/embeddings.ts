import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { extractSkills } from "../../lib/skills.js";

/** Must match the vector(N) columns in db/migrations.ts. */
export const EMBEDDING_DIMENSIONS = 1024;

export type EmbeddingInput = "document" | "query";

/**
 * Typical cosine-similarity range for related texts with each provider. Used to turn a raw
 * similarity into a 0-1 "semantic match" score that means roughly the same thing for both.
 */
export function similarityRange(): { floor: number; ceil: number } {
  return config.embeddings.provider === "voyage" ? { floor: 0.3, ceil: 0.75 } : { floor: 0.05, ceil: 0.55 };
}

export function semanticScore(similarity: number | null | undefined): number {
  if (similarity == null || Number.isNaN(similarity)) return 0;
  const { floor, ceil } = similarityRange();
  return Math.min(1, Math.max(0, (similarity - floor) / (ceil - floor)));
}

export function embeddingModelName(): string {
  return config.embeddings.provider === "voyage" ? config.embeddings.voyageModel : "local-hash-v1";
}

/**
 * Embeds texts. Returns null for every text when the provider fails: callers store a NULL
 * embedding (search then falls back to full-text ranking) rather than mixing vectors from
 * different models in one column.
 */
export async function embed(texts: string[], inputType: EmbeddingInput): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  if (config.embeddings.provider === "local") return texts.map((t) => localEmbedding(t));
  try {
    return await voyageEmbed(texts, inputType);
  } catch (err) {
    logger.error({ err }, "Embedding request failed; storing without embedding");
    return texts.map(() => null);
  }
}

export async function embedOne(text: string, inputType: EmbeddingInput): Promise<number[] | null> {
  const [vec] = await embed([text], inputType);
  return vec ?? null;
}

// ---------------------------------------------------------------- Voyage AI
// Anthropic does not offer an embeddings model; Voyage AI is its recommended provider.

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

async function voyageEmbed(texts: string[], inputType: EmbeddingInput): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  const BATCH = 64;
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH);
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.embeddings.voyageApiKey}`,
      },
      body: JSON.stringify({
        input: batch,
        model: config.embeddings.voyageModel,
        input_type: inputType,
        output_dimension: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
    }
    const json = (await res.json()) as VoyageResponse;
    for (const item of json.data) out[start + item.index] = item.embedding;
  }
  return out;
}

// ---------------------------------------------------------------- local fallback
// Feature hashing over words, bigrams and recognised skills. Not as good as a learned model,
// but deterministic, free, and good enough for keyword-level semantic matching in dev/tests.

const STOPWORDS = new Set(
  "a an the and or but if then of to in on at for with by from as is are was were be been being this that these those it its we you they i our your their my me us them he she his her will would can could should may might must do does did done have has had not no yes so than too very just about into over under up down out more most less least such any all each other some what which who whom whose where when why how job role position looking seeking work team company candidate experience years year".split(
    " ",
  ),
);

function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.]*[a-z0-9+#]|[a-z0-9]/g) ?? [])
    .filter((w) => !STOPWORDS.has(w) && w.length > 1)
    .map(stem);
}

export function localEmbedding(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    const sign = (fnv1a(feature, 0x9747b28c) & 1) === 0 ? 1 : -1;
    vec[h % EMBEDDING_DIMENSIONS]! += sign * weight;
  };
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    add(`w:${tokens[i]}`, 1);
    if (i + 1 < tokens.length) add(`b:${tokens[i]}_${tokens[i + 1]}`, 0.5);
  }
  for (const skill of extractSkills(text)) add(`s:${skill}`, 3);

  // sub-linear term frequency, then L2 normalise
  for (let i = 0; i < vec.length; i++) vec[i] = Math.sign(vec[i]!) * Math.sqrt(Math.abs(vec[i]!));
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
