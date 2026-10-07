/** Helpers that drive whole user journeys through the HTTP API, the way the frontend will. */
import { expect, vi } from "vitest";
import type { Harness } from "./helpers.js";

export const APEX = "brillianda.test";
export const APEX_ORIGIN = `https://${APEX}`;
export const schoolHost = (subdomain: string) => `${subdomain}.${APEX}`;

/** Value of a cookie set by a response (empty string when it was cleared). */
export function setCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [k, ...v] = pair!.split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export interface Client {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  del(path: string): Promise<Response>;
  cookies: Map<string, string>;
}

/** A browser on one host: keeps cookies, sends Origin on writes, JSON bodies. */
export function browser(h: Harness, host: string, cookies = new Map<string, string>()): Client {
  const send = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { host };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET") headers.origin = `https://${host}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await h.app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const header of res.headers.getSetCookie()) {
      const [pair, ...attrs] = header.split(";");
      const [k, ...v] = pair!.split("=");
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired || v.join("=") === "") cookies.delete(k!);
      else cookies.set(k!, v.join("="));
    }
    return res;
  };
  return {
    get: (p) => send("GET", p),
    post: (p, b) => send("POST", p, b),
    del: (p) => send("DELETE", p),
    cookies,
  };
}

export const codeFrom = (text: string) => /\b(\d{6})\b/.exec(text)?.[1];
export const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];

export async function waitForMail(h: Harness, to: string, tag: string) {
  return vi.waitFor(
    () => {
      const m = h.mail.sent.filter((x) => x.to === to && x.tag === tag).at(-1);
      if (!m) throw new Error(`no ${tag} email to ${to} yet`);
      return m;
    },
    { timeout: 3000, interval: 20 },
  );
}

export interface SignupInput {
  schoolName: string;
  subdomain: string;
  email: string;
  password: string;
  fullName?: string;
  existingPassword?: string;
}

/** The whole signup journey on the apex. Returns the handover token for the new school. */
export async function signUp(h: Harness, input: SignupInput) {
  const apex = browser(h, APEX);
  let res = await apex.post("/v1/signup/school", { name: input.schoolName, levelsOffered: ["secondary"], state: "Rivers", phone: "0803 000 0001" });
  expect(res.status).toBe(200);
  res = await apex.post("/v1/signup/owner", { fullName: input.fullName ?? "Ngozi Okafor", email: input.email, password: input.password });
  expect(res.status).toBe(200);
  const code = codeFrom((await waitForMail(h, input.email, "signup_code")).text)!;
  res = await apex.post("/v1/signup/verify-email", { code });
  expect(res.status).toBe(200);
  res = await apex.post("/v1/signup/complete", {
    subdomain: input.subdomain,
    ...(input.existingPassword ? { existingPassword: input.existingPassword } : {}),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as { handoverUrl: string; school: { id: string } };
  return { handoverToken: tokenFrom(body.handoverUrl)!, schoolId: body.school.id, apex };
}

/** Signs up a school and lands signed in on its address, like the real handover page. */
export async function signUpAndLand(h: Harness, input: SignupInput) {
  const { handoverToken, schoolId } = await signUp(h, input);
  const school = browser(h, schoolHost(input.subdomain));
  const res = await school.post("/v1/auth/handover", { token: handoverToken });
  expect(res.status).toBe(200);
  return { school, schoolId };
}
