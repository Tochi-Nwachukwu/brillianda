import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { AiError, GeminiAi, OffAi, REPLY_SCHEMA } from "../src/lib/ai.js";
import { silentLogger } from "../src/lib/logger.js";
import { generateRequestSchema, questionSchema } from "../src/lib/questions.js";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let teacher: Client;
let student: Client;
const level: Record<string, string> = {};
const subject: Record<string, string> = {};

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}
const problem = async (res: Response | Promise<Response>, status: number) => {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as { code: string; detail: string; resetsOn?: string; errors?: { pointer: string; detail: string }[] };
};

const base = { marks: 1, topic: "Fractions", difficulty: "easy" };
const objective = { type: "objective", text: "What is 1/2 + 1/4?", options: ["3/4", "1/6", "2/6", "1"], answer: 0, ...base };
const truth = { type: "trueFalse", text: "1/2 is bigger than 1/3.", answer: true, ...base };
const ask = { purpose: "test", subjectId: "", levelId: "", topics: ["Fractions"], notes: "Keep the numbers small", counts: { objective: 1, trueFalse: 1, fillGap: 0, theory: 0 }, difficulty: "mixed" };
/** A model's reply, in the flat shape it's asked for. */
const reply = (extra: object[] = []) =>
  JSON.stringify({
    questions: [
      { type: "objective", text: "What is 1/2 + 1/4?", marks: 1, topic: "Fractions", difficulty: "easy", options: ["3/4", "1/6", "2/6", "1"], answerIndex: 0 },
      { type: "trueFalse", text: "1/2 is bigger than 1/3.", marks: 1, topic: "Fractions", difficulty: "easy", answerTrue: true },
      ...extra,
    ],
  });

type Page = {
  pairs: { subjectName: string; levelName: string }[];
  questions: { id: string; question: { text: string }; source: string; by: string; byMe: boolean }[];
  usage: { used: number; limit: number; resetsOn: string };
  canEditAll: boolean;
  aiEnabled: boolean;
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness({ aiMonthlyLimit: 4 });
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Oak Grammar", subdomain: "oakgrammar", email: "owner@oakgrammar.test", password: "oakgrammar-owner-pw", fullName: "Funmi Oak" }));
  await json(
    owner.send("POST", "/v1/classes/setup", {
      levels: [
        { key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" },
        { key: "jss2", name: "JSS 2", short: "JSS2", section: "junior" },
      ],
      arms: [{ name: "Gold", code: "GOL" }],
      armsByLevel: [[0], [0]],
    }),
    201,
  );
  for (const l of (await json<{ levels: { id: string; name: string }[] }>(owner.get("/v1/classes"))).levels) level[l.name] = l.id;
  const arms = (await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"))).arms;
  await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Mathematics", code: "MTH" }, { name: "English Studies", code: "ENG" }] });
  for (const s of (await json<{ subjects: { id: string; name: string }[] }>(owner.get("/v1/subjects"))).subjects) {
    subject[s.name] = s.id;
    for (const l of Object.values(level)) await owner.send("PUT", `/v1/subjects/${s.id}/levels/${l}`, { kind: "compulsory" });
  }
  await json(owner.post("/v1/invitations", { email: "tunde@oakgrammar.test", fullName: "Tunde Teach", role: "teacher" }), 201);
  teacher = browser(h, schoolHost("oakgrammar"));
  const t = await json<{ user: { id: string } }>(teacher.post("/v1/invitations/accept", { token: tokenFrom((await waitForMail(h, "tunde@oakgrammar.test", "invitation")).text)!, password: "teacher-password" }));
  expect((await owner.send("PUT", `/v1/teachers/${t.user.id}/subject-classes`, [{ armId: arms.find((a) => a.label === "JSS 1")!.id, subjectId: subject.Mathematics }])).status).toBe(204);
  const ada = (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: "Ada", lastName: "Obi", gender: "female", armId: arms[0]!.id }), 201)).id;
  await json(owner.post(`/v1/students/${ada}/invite`, { email: "ada@pupils.test" }), 201);
  student = browser(h, schoolHost("oakgrammar"));
  await json(student.post("/v1/invitations/accept", { token: tokenFrom((await waitForMail(h, "ada@pupils.test", "invitation")).text)!, password: "student-password" }));
  ask.subjectId = subject.Mathematics!;
  ask.levelId = level["JSS 1"]!;
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("question rules", () => {
  it("checks a question: the right option must exist", () => {
    expect(questionSchema.safeParse(objective).success).toBe(true);
    expect(questionSchema.safeParse({ ...objective, answer: 4 }).error?.issues[0]?.message).toBe("Choose the right option");
    expect(questionSchema.safeParse({ ...objective, options: ["only one"] }).success).toBe(false);
  });
  it("asks for between 1 and 60 questions", () => {
    const req = { ...ask, subjectId: crypto.randomUUID(), levelId: crypto.randomUUID() };
    expect(generateRequestSchema.safeParse({ ...req, counts: { objective: 0, trueFalse: 0, fillGap: 0, theory: 0 } }).success).toBe(false);
    expect(generateRequestSchema.safeParse({ ...req, counts: { objective: 20, trueFalse: 0, fillGap: 0, theory: 5 } }).success).toBe(true);
  });
});

describe("the question bank", () => {
  it("offers a teacher the subjects and classes they teach; owners and admins all", async () => {
    const mine = await json<Page>(teacher.get("/v1/questions"));
    expect(mine.pairs.map((p) => `${p.levelName} ${p.subjectName}`)).toEqual(["JSS 1 Mathematics"]);
    expect(mine).toMatchObject({ questions: [], canEditAll: false, aiEnabled: true, usage: { used: 0, limit: 4, resetsOn: "2026-11-01" } });
    expect((await json<Page>(owner.get("/v1/questions"))).pairs.map((p) => `${p.levelName} ${p.subjectName}`)).toEqual([
      "JSS 1 English Studies",
      "JSS 1 Mathematics",
      "JSS 2 English Studies",
      "JSS 2 Mathematics",
    ]);
    expect((await student.get("/v1/questions")).status).toBe(403);
    expect((await student.post("/v1/questions/generate", ask)).status).toBe(403);
  });

  it("saves checked questions, only where the person teaches", async () => {
    const save = (who: Client, body: object) => who.post("/v1/questions", { subjectId: subject.Mathematics, levelId: level["JSS 1"], source: "teacher", ...body });
    expect((await problem(save(teacher, { levelId: level["JSS 2"], questions: [objective] }), 403)).detail).toBe("You can only write questions for the subjects and classes you teach.");
    expect((await problem(save(teacher, { questions: [{ ...objective, answer: 7 }] }), 422)).errors![0]!.pointer).toBe("#/questions/0/answer");
    expect(await json(save(teacher, { questions: [objective, truth] }))).toEqual({ saved: 2 });
    expect(await json(save(owner, { questions: [{ ...truth, text: "0.5 equals 1/2." }] }))).toEqual({ saved: 1 });
    expect(await json(save(owner, { subjectId: subject["English Studies"], questions: [{ type: "fillGap", text: "The plural of child is ____.", answers: ["children"], ...base }] }))).toEqual({ saved: 1 });
    const page = await json<Page>(teacher.get("/v1/questions"));
    expect(page.questions).toHaveLength(3);
    expect(page.questions.filter((q) => q.byMe).map((q) => q.by)).toEqual(["Tunde Teach", "Tunde Teach"]);
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Added 1 question to the JSS 1 English Studies question bank");
  });

  it("lets a teacher change only their own questions; owners and admins any", async () => {
    const page = await json<Page>(teacher.get("/v1/questions"));
    const mine = page.questions.find((q) => q.byMe)!;
    const theirs = page.questions.find((q) => !q.byMe)!;
    expect((await teacher.send("PUT", `/v1/questions/${mine.id}`, { question: { ...truth, text: "1/2 is smaller than 1/3.", answer: false } })).status).toBe(204);
    expect((await problem(teacher.send("PUT", `/v1/questions/${theirs.id}`, { question: truth }), 403)).detail).toBe("You can change your own questions only. Ask an admin to change this one.");
    expect((await teacher.del(`/v1/questions/${theirs.id}`)).status).toBe(403);
    expect((await owner.send("PUT", `/v1/questions/${mine.id}`, { question: { ...truth, marks: 2 } })).status).toBe(204);
    expect((await owner.del(`/v1/questions/${theirs.id}`)).status).toBe(204);
    expect((await teacher.del(`/v1/questions/${theirs.id}`)).status).toBe(404);
    expect((await json<Page>(teacher.get("/v1/questions"))).questions).toHaveLength(2);
  });
});

describe("generating questions", () => {
  it("drafts from the subject, class and the teacher's words only, and saves nothing", async () => {
    h.ai.replies.push(reply([{ type: "trueFalse", text: "An extra one.", marks: 1, topic: "", difficulty: "easy", answerTrue: false }]));
    const res = await json<{ questions: { type: string; answer: unknown }[]; usage: { used: number } }>(teacher.post("/v1/questions/generate", ask));
    expect(res.questions).toEqual([{ ...objective }, { ...truth }]);
    expect(res.usage.used).toBe(1);
    const sent = h.ai.asked.at(-1)!;
    expect(sent.ctx).toEqual({ subjectName: "Mathematics", levelName: "JSS 1" });
    expect(sent.prompt).toContain("Topics: Fractions");
    expect(sent.prompt).toContain("The teacher's notes: Keep the numbers small");
    expect(sent.prompt).not.toMatch(/Ada|Obi/);
    expect((await json<Page>(teacher.get("/v1/questions"))).questions).toHaveLength(2);
  });

  it("retries once when the reply doesn't fit the format, then gives up without counting it", async () => {
    h.ai.replies.push("not json", reply());
    expect((await json<{ questions: unknown[] }>(teacher.post("/v1/questions/generate", ask))).questions).toHaveLength(2);
    h.ai.replies.push(JSON.stringify({ questions: [{ type: "objective", text: "Broken", marks: 1, topic: "", difficulty: "easy", options: ["a"], answerIndex: 3 }] }), "{}");
    expect((await problem(teacher.post("/v1/questions/generate", ask), 502)).code).toBe("ai_invalid_output");
    h.ai.replies.push(new AiError("refused", "This topic couldn’t be used. Try different words."));
    expect(await problem(teacher.post("/v1/questions/generate", ask), 422)).toMatchObject({ code: "ai_refused", detail: "This topic couldn’t be used. Try different words." });
    expect((await json<Page>(teacher.get("/v1/questions"))).usage.used).toBe(2);
  });

  it("is only for the subjects and classes the person teaches", async () => {
    expect((await problem(teacher.post("/v1/questions/generate", { ...ask, levelId: level["JSS 2"] }), 403)).detail).toBe("You can only write questions for the subjects and classes you teach.");
    expect((await problem(teacher.post("/v1/questions/generate", { ...ask, counts: { objective: 0, trueFalse: 0, fillGap: 0, theory: 0 } }), 422)).errors![0]!.pointer).toBe("#/counts");
  });

  it("stops at the school's monthly allowance", async () => {
    h.ai.replies.push(reply(), reply());
    await json(owner.post("/v1/questions/generate", ask));
    await json(teacher.post("/v1/questions/generate", ask));
    const over = await problem(teacher.post("/v1/questions/generate", ask), 429);
    expect(over).toMatchObject({ code: "ai_quota_exceeded", resetsOn: "2026-11-01", detail: "Your school has used this month’s 4 question generations. They reset on 2026-11-01." });
  });

  it("answers ai_disabled while the provider is off", async () => {
    const off = createApp({ ...h.deps, ai: new OffAi() });
    const cookie = [...teacher.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const host = schoolHost("oakgrammar");
    const page = await off.request("/v1/questions", { headers: { host, cookie } });
    expect(((await page.json()) as Page).aiEnabled).toBe(false);
    const res = await off.request("/v1/questions/generate", { method: "POST", headers: { host, cookie, origin: `https://${host}`, "content-type": "application/json" }, body: JSON.stringify(ask) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("ai_disabled");
  });
});

describe("the Gemini adapter", () => {
  const req = generateRequestSchema.parse({ ...ask, subjectId: crypto.randomUUID(), levelId: crypto.randomUUID() });
  const ctx = { subjectName: "Mathematics", levelName: "JSS 1" };
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fake = (...responses: (Response | Error)[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      fn: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const next = responses.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
    };
  };
  const ok = (text: string) => answer(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 340 } });

  it("asks for the question format with the key in a header, and counts tokens", async () => {
    const f = fake(ok(reply()));
    const out = await new GeminiAi({ apiKey: "test-key", model: "gemini-3.8-flash" }, silentLogger, f.fn).generate(req, ctx);
    expect(out).toMatchObject({ model: "gemini-3.8-flash", inputTokens: 120, outputTokens: 340 });
    expect(out.questions.map((q) => q.type)).toEqual(["objective", "trueFalse"]);
    expect(f.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    expect(f.calls[0]!.url).not.toContain("test-key");
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body.generationConfig.responseFormat.text).toEqual({ mimeType: "APPLICATION_JSON", schema: JSON.parse(JSON.stringify(REPLY_SCHEMA)) });
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(body.systemInstruction.parts[0].text).toContain("JSS 1");
    expect(body.contents[0].parts[0].text).toContain("Subject: Mathematics");
  });

  it("retries a bad reply once; maps refusals and outages", async () => {
    const twice = fake(ok("nope"), ok(reply()));
    expect((await new GeminiAi({ apiKey: "k", model: "m" }, silentLogger, twice.fn).generate(req, ctx)).inputTokens).toBe(240);
    const kind = async (...r: (Response | Error)[]) => ((await new GeminiAi({ apiKey: "k", model: "m" }, silentLogger, fake(...r).fn).generate(req, ctx).catch((e: AiError) => e)) as AiError).kind;
    expect(await kind(ok("nope"), ok("still nope"))).toBe("invalid_output");
    expect(await kind(answer(200, { promptFeedback: { blockReason: "SAFETY" } }))).toBe("refused");
    expect(await kind(answer(200, { candidates: [{ finishReason: "SAFETY" }] }))).toBe("refused");
    expect(await kind(answer(429, { error: { message: "Resource exhausted" } }))).toBe("unavailable");
    expect(await kind(new Error("ECONNRESET"))).toBe("unavailable");
  });
});

describe("AI settings", () => {
  const env = { DATABASE_URL: "postgres://x@y/z", ROOT_DOMAIN: "brillianda.com", AUTH_SECRET: "a".repeat(44), PROXY_SHARED_SECRET: "b".repeat(20) };
  it("is off by default; Gemini needs its key; production needs the terms cleared", () => {
    expect(loadEnv(env).AI_PROVIDER).toBe("off");
    expect(() => loadEnv({ ...env, AI_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadEnv({ ...env, AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" })).not.toThrow();
    expect(() => loadEnv({ ...env, NODE_ENV: "production", APP_ENV: "production", AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" })).toThrow(/AI_TERMS_CLEARED/);
  });
});
