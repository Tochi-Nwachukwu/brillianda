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
    `Questions wanted: ${counts.join(", ")}`,
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
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...QUESTION_TYPES] },
          text: { type: "string", description: "The question" },
          marks: { type: "number", minimum: 0.5, maximum: 50 },
          topic: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          options: { type: "array", items: { type: "string" }, description: "objective only: 2 to 5 options" },
          answerIndex: { type: "integer", minimum: 0, description: "objective only: the right option, counting from 0" },
          answerTrue: { type: "boolean", description: "trueFalse only: whether the statement is true" },
          answers: { type: "array", items: { type: "string" }, description: "fillGap only: every accepted answer" },
          guide: { type: "string", description: "theory only: what a full answer includes" },
        },
        required: ["type", "text", "marks", "topic", "difficulty"],
      },
    },
  },
  required: ["questions"],
} as const;

type Flat = { type?: string; text?: string; marks?: number; topic?: string; difficulty?: string; options?: string[]; answerIndex?: number; answerTrue?: boolean; answers?: string[]; guide?: string };

function fromFlat(f: Flat): unknown {
  const base = { type: f.type, text: f.text, marks: f.marks, topic: f.topic ?? "", difficulty: f.difficulty };
  if (f.type === "objective") return { ...base, options: f.options, answer: f.answerIndex };
  if (f.type === "trueFalse") return { ...base, answer: f.answerTrue };
  if (f.type === "fillGap") return { ...base, answers: f.answers };
  return { ...base, guide: f.guide ?? "" };
}

/** Checks a reply: valid questions, and the counts asked for (extras dropped). */
export function checkReply(reply: unknown, req: GenerateRequest): { ok: true; questions: Question[] } | { ok: false; reason: string } {
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
  for (const item of items) {
    const parsed = questionSchema.safeParse(fromFlat((item ?? {}) as Flat));
    if (!parsed.success) return { ok: false, reason: `a question failed: ${parsed.error.issues[0]?.message}` };
    const q = parsed.data as Question;
    byType.set(q.type, [...(byType.get(q.type) ?? []), q]);
  }
  const out: Question[] = [];
  for (const t of QUESTION_TYPES) {
    const got = byType.get(t) ?? [];
    if (got.length < req.counts[t]) return { ok: false, reason: `too few ${t}` };
    out.push(...got.slice(0, req.counts[t]));
  }
  return { ok: true, questions: out };
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
    private readonly opts: { apiKey: string; model: string; thinking?: AiThinking; baseUrl?: string; timeoutMs?: number },
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
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
        });
      } catch (err) {
        this.logger.error("ai unreachable", { provider: "gemini", reason: (err as Error).message });
        throw new AiError("unavailable", "Generating didn’t finish. Try again.");
      }
      const reply = (await res.json().catch(() => ({}))) as GeminiReply;
      if (!res.ok) {
        this.logger.error("ai failed", { provider: "gemini", status: res.status, reason: reply.error?.message });
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
        this.logger.info("ai generated", { provider: "gemini", model: this.opts.model, questions: checked.questions.length, inputTokens, outputTokens });
        return { questions: checked.questions, model: this.opts.model, inputTokens, outputTokens };
      }
      this.logger.warn("ai reply didn't match", { provider: "gemini", attempt, reason: checked.reason });
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
