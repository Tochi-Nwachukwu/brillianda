/**
 * Drafting questions with AI (B7; the front end's docs/ai-integration.md). One small interface, so
 * the provider is a setting, not a rewrite:
 *   OffAi       the default (AI_PROVIDER=off): generating answers "not switched on"
 *   GeminiAi    AI_PROVIDER=gemini, over plain fetch (no SDK dependency)
 *   MemoryAi    tests: canned answers
 *
 * Step 0 of the front end's guide: Google's terms restrict Gemini in a service likely to be used by
 * under-18s, and Brillianda has a student portal. Keep AI_PROVIDER=off on any environment real
 * students use until that's settled in writing.
 *
 * What goes to the model: the subject, the class level, the teacher's topics and notes, and the
 * counts. Never a student's name, record, score or answer.
 */
import { QUESTION_TYPES, type Question, type QuestionType } from "@brillianda/core";
import type { Logger } from "./logger.js";
import { questionSchema, type GenerateRequest } from "./questions.js";

export type AiContext = { subjectName: string; levelName: string };
export type AiResult = { questions: Question[]; model: string; inputTokens: number | null; outputTokens: number | null };

/** Why a generation failed; the route maps each to its problem code. */
export class AiError extends Error {
  constructor(
    readonly kind: "disabled" | "unavailable" | "invalid_output" | "refused",
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface Ai {
  readonly provider: string;
  readonly enabled: boolean;
  generate(req: GenerateRequest, ctx: AiContext): Promise<AiResult>;
}

export class OffAi implements Ai {
  readonly provider = "off";
  readonly enabled = false;
  async generate(): Promise<AiResult> {
    throw new AiError("disabled", "Generating questions isn’t switched on yet. Write questions yourself for now.");
  }
}

export class MemoryAi implements Ai {
  readonly provider = "memory";
  readonly enabled = true;
  /** Raw answers to return, in turn (strings are parsed like a model's reply), or errors to throw. */
  readonly replies: (unknown | Error)[] = [];
  readonly asked: { req: GenerateRequest; ctx: AiContext; prompt: string }[] = [];

  async generate(req: GenerateRequest, ctx: AiContext): Promise<AiResult> {
    for (let attempt = 1; ; attempt++) {
      this.asked.push({ req, ctx, prompt: userPrompt(req, ctx) });
      const next = this.replies.shift();
      if (next instanceof Error) throw next;
      const checked = checkReply(next, req);
      if (checked.ok) return { questions: checked.questions, model: "memory", inputTokens: 100, outputTokens: 200 };
      if (attempt >= 2) throw new AiError("invalid_output", "Generating didn’t finish. Try again.");
    }
  }
}

// ——— The prompt and the reply's shape ———

export function systemInstruction(ctx: AiContext): string {
  return [
    "You write questions for Nigerian school teachers to use in tests, assignments and exams.",
    `The class is ${ctx.levelName}. Follow the Nigerian national curriculum (NERDC, 2025 edition) for that level, and keep every question age-appropriate for its pupils.`,
    "Write in British English. Each question must be clear and unambiguous, with exactly one correct answer (theory questions: a marking guide listing what a full answer includes).",
    "Give exactly the number of each type of question asked for.",
    "Answer only in the JSON format given. Do not include anything else.",
  ].join("\n");
}

export function userPrompt(req: GenerateRequest, ctx: AiContext): string {
  const counts = QUESTION_TYPES.filter((t) => req.counts[t] > 0).map((t) => `${req.counts[t]} ${LABEL[t]}`);
  return [
    `Subject: ${ctx.subjectName}`,
    `Class: ${ctx.levelName}`,
    `Purpose: a ${req.purpose}`,
    `Topics: ${req.topics.join("; ")}`,
    `Difficulty: ${req.difficulty === "mixed" ? "a mix of easy, medium and hard" : req.difficulty}`,
    `Questions wanted, exactly: ${counts.join(", ")} (${QUESTION_TYPES.filter((t) => req.counts[t] > 0).map((t) => `${req.counts[t]} with type "${t}"`).join(", ")})`,
    ...(req.notes ? [`The teacher's notes: ${req.notes}`] : []),
  ].join("\n");
}

const LABEL: Record<QuestionType, string> = {
  objective: "objective (multiple choice, 4 options unless the teacher says otherwise)",
  trueFalse: "true or false",
  fillGap: "fill in the gap (write the gap as ____)",
  theory: "theory",
};

/**
 * A flat shape the model fills in (Gemini handles flat schemas better than unions); each item is
 * turned into a Question and checked with questionSchema.
 */
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "Exactly the number of each type asked for. Every item has every field: null for the fields its type doesn't use.",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...QUESTION_TYPES] },
          text: { type: "string", description: "The question" },
          marks: { type: "number", minimum: 0.5, maximum: 50 },
          topic: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          options: { type: ["array", "null"], items: { type: "string" }, description: "objective: 4 options (2 to 5). Others: null" },
          answerIndex: { type: ["integer", "null"], minimum: 0, description: "objective: the right option, counting from 0. Others: null" },
          answerTrue: { type: ["boolean", "null"], description: "trueFalse: whether the statement is true. Others: null" },
          answers: { type: ["array", "null"], items: { type: "string" }, description: "fillGap: every accepted answer (at least one). Others: null" },
          guide: { type: ["string", "null"], description: "theory: what a full answer includes. Others: null" },
        },
        required: ["type", "text", "marks", "topic", "difficulty", "options", "answerIndex", "answerTrue", "answers", "guide"],
      },
    },
  },
  required: ["questions"],
} as const;

type Flat = {
  type?: string;
  text?: string;
  marks?: number | null;
  topic?: string | null;
  difficulty?: string | null;
  options?: string[] | null;
  answerIndex?: number | null;
  answerTrue?: boolean | null;
  answers?: string[] | null;
  guide?: string | null;
};

const DEFAULT_MARKS: Record<string, number> = { objective: 1, trueFalse: 1, fillGap: 1, theory: 5 };
const DIFFICULTY = new Set(["easy", "medium", "hard"]);

/** Turns a flat item into a Question to check, filling the harmless gaps (marks, topic, difficulty) a model may leave. */
function fromFlat(f: Flat): unknown {
  const marks = typeof f.marks === "number" && f.marks >= 0.5 && f.marks <= 50 ? f.marks : (DEFAULT_MARKS[f.type ?? ""] ?? 1);
  const base = { type: f.type, text: f.text, marks, topic: (f.topic ?? "").slice(0, 80), difficulty: DIFFICULTY.has(f.difficulty ?? "") ? f.difficulty : "medium" };
  if (f.type === "objective") return { ...base, options: f.options ?? undefined, answer: f.answerIndex ?? undefined };
  if (f.type === "trueFalse") return { ...base, answer: f.answerTrue ?? undefined };
  if (f.type === "fillGap") return { ...base, answers: f.answers ?? undefined };
  return { ...base, guide: f.guide ?? "" };
}

/**
 * Checks a reply. Questions that don't pass are dropped (and counted), extras beyond what was asked
 * are dropped too; the rest come back in the order asked for. Only a reply with nothing usable
 * fails: the teacher reviews every draft anyway, and a short batch beats an error.
 */
export function checkReply(reply: unknown, req: GenerateRequest): { ok: true; questions: Question[]; dropped: string[] } | { ok: false; reason: string } {
  let body = reply;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return { ok: false, reason: "not JSON" };
    }
  }
  const items = (body as { questions?: unknown })?.questions;
  if (!Array.isArray(items)) return { ok: false, reason: "no questions" };
  const byType = new Map<string, Question[]>();
  const dropped: string[] = [];
  for (const item of items) {
    const parsed = questionSchema.safeParse(fromFlat((item ?? {}) as Flat));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      dropped.push(`${(item as Flat)?.type ?? "unknown"}: ${issue?.path.join(".") || "question"} ${issue?.message ?? ""}`.trim());
      continue;
    }
    const q = parsed.data as Question;
    byType.set(q.type, [...(byType.get(q.type) ?? []), q]);
  }
  const out: Question[] = [];
  for (const t of QUESTION_TYPES) {
    const got = byType.get(t) ?? [];
    if (got.length < req.counts[t]) dropped.push(`${t}: ${req.counts[t] - got.length} short`);
    out.push(...got.slice(0, req.counts[t]));
  }
  if (!out.length) return { ok: false, reason: dropped.slice(0, 5).join("; ") || "no usable questions" };
  return { ok: true, questions: out, dropped };
}

// ——— Gemini ———

/** How much the model reasons before answering: more is slower and costs more. */
export const AI_THINKING = ["minimal", "low", "medium", "high"] as const;
export type AiThinking = (typeof AI_THINKING)[number];

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Gemini's generateContent over REST, with structured output. Paid-tier key only: the free tier
 * lets Google use prompts to improve its products. 60-second timeout, one retry when the reply
 * doesn't match the shape.
 */
export class GeminiAi implements Ai {
  readonly provider = "gemini";
  readonly enabled = true;

  constructor(
    private readonly opts: { apiKey: string; model: string; thinking?: AiThinking; baseUrl?: string; timeoutMs?: number; retryDelayMs?: number },
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generate(req: GenerateRequest, ctx: AiContext): Promise<AiResult> {
    const url = `${(this.opts.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(this.opts.model)}:generateContent`;
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction(ctx) }] },
      contents: [{ role: "user", parts: [{ text: userPrompt(req, ctx) }] }],
      generationConfig: {
        responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: REPLY_SCHEMA } },
        // Gemini 3 models think at "high" unless told otherwise, which took over a minute for six
        // questions on staging (28 Oct 2026). Drafting questions doesn't need deep reasoning.
        thinkingConfig: { thinkingLevel: this.opts.thinking ?? "low" },
      },
    });
    let inputTokens = 0;
    let outputTokens = 0;
    // One time budget for the whole generation (every attempt included), under Vercel's limit.
    const deadline = Date.now() + (this.opts.timeoutMs ?? 55_000);
    const model = this.opts.model;
    let busyRetried = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
          body,
          signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
        });
      } catch (err) {
        this.logger.error("ai unreachable", { provider: "gemini", model, reason: (err as Error).message });
        throw new AiError("unavailable", "Generating didn’t finish. Try again.");
      }
      const reply = (await res.json().catch(() => ({}))) as GeminiReply;
      if (!res.ok) {
        // "High demand" (503) and "too many requests" (429) are usually brief: one more try after a pause, if time allows.
        const busy = res.status === 429 || res.status === 503;
        const pause = this.opts.retryDelayMs ?? 2_000;
        if (busy && !busyRetried && deadline - Date.now() > pause + 10_000) {
          busyRetried = true;
          attempt--;
          this.logger.warn("ai busy, retrying", { provider: "gemini", model, status: res.status });
          await new Promise((r) => setTimeout(r, pause));
          continue;
        }
        this.logger.error("ai failed", { provider: "gemini", model, status: res.status, reason: reply.error?.message });
        throw new AiError("unavailable", "Generating didn’t finish. Try again.");
      }
      inputTokens += reply.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += reply.usageMetadata?.candidatesTokenCount ?? 0;
      const candidate = reply.candidates?.[0];
      if (reply.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(candidate?.finishReason ?? "")) {
        throw new AiError("refused", "This topic couldn’t be used. Try different words.");
      }
      const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const checked = checkReply(text, req);
      if (checked.ok) {
        this.logger.info("ai generated", { provider: "gemini", model, questions: checked.questions.length, dropped: checked.dropped.slice(0, 5), inputTokens, outputTokens });
        return { questions: checked.questions, model: this.opts.model, inputTokens, outputTokens };
      }
      this.logger.warn("ai reply didn't match", { provider: "gemini", model, attempt, reason: checked.reason });
      if (attempt >= 2) throw new AiError("invalid_output", "Generating didn’t finish. Try again.");
    }
  }
}

type GeminiReply = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
};
