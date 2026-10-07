/**
 * Email content. Plain, short, mobile-friendly. The school's name leads, Brillianda stays small.
 * (React Email templates in packages/email can replace these later without touching callers.)
 */
import type { EmailMessage } from "./lib/mailer.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(heading: string, paragraphs: string[], action?: { label: string; url: string }, code?: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d1d1b">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<tr><td>
<h1 style="font-size:20px;margin:0 0 16px">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="font-size:16px;line-height:1.5;margin:0 0 14px">${esc(p)}</p>`).join("")}
${code ? `<p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:20px 0;font-family:ui-monospace,Menlo,monospace">${esc(code)}</p>` : ""}
${action ? `<p style="margin:22px 0"><a href="${esc(action.url)}" style="background:#1d1d1b;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-size:16px;display:inline-block">${esc(action.label)}</a></p><p style="font-size:13px;color:#6b6b66;word-break:break-all">${esc(action.url)}</p>` : ""}
<p style="font-size:12px;color:#8a8a84;margin-top:24px">Powered by Brillianda</p>
</td></tr></table></body></html>`;
}

function message(to: string, tag: string, subject: string, heading: string, lines: string[], action?: { label: string; url: string }, code?: string): EmailMessage {
  const text = [heading, "", ...lines, ...(code ? ["", code] : []), ...(action ? ["", `${action.label}: ${action.url}`] : [])].join("\n");
  return { to, tag, subject, text, html: layout(heading, lines, action, code) };
}

export const emails = {
  signupCode: (to: string, code: string) =>
    message(to, "signup_code", `${code} is your Brillianda code`, "Confirm your email", [
      "Enter this code to finish creating your school. It expires in 10 minutes.",
      "If you did not start a signup, ignore this email.",
    ], undefined, code),

  welcome: (to: string, schoolName: string, url: string) =>
    message(to, "welcome", `${schoolName} is ready on Brillianda`, `${schoolName} is ready`, [
      "Your school's address is below. Bookmark it, and add it to your phone's home screen.",
    ], { label: "Open your school", url }),

  findMySchool: (to: string, schools: { name: string; url: string }[]) =>
    message(to, "find_school", "Your Brillianda schools", "Your schools", [
      "Here are the schools this email can sign in to:",
      ...schools.map((s) => `${s.name}: ${s.url}`),
    ]),

  passwordReset: (to: string, schoolName: string, url: string) =>
    message(to, "password_reset", `Reset your password for ${schoolName}`, "Reset your password", [
      `Someone asked to reset the password for ${to} at ${schoolName}. The link works once, for 30 minutes.`,
      "If it was not you, ignore this email; your password stays the same.",
    ], { label: "Choose a new password", url }),

  passwordChanged: (to: string, schoolName: string) =>
    message(to, "password_changed", "Your Brillianda password was changed", "Password changed", [
      `The password for ${to} was just changed from ${schoolName}, and every other device was signed out.`,
      "If this was not you, reset your password now and tell your school's owner.",
    ]),

  magicLink: (to: string, schoolName: string, url: string) =>
    message(to, "login_link", `Sign in to ${schoolName}`, `Sign in to ${schoolName}`, [
      "Use this link to sign in. It works once, for 15 minutes.",
      "If you did not ask for it, ignore this email.",
    ], { label: "Sign in", url }),

  invitation: (to: string, schoolName: string, inviterName: string, role: string, url: string) =>
    message(to, "invitation", `${inviterName} invited you to ${schoolName}`, `Join ${schoolName} on Brillianda`, [
      `${inviterName} invited you to help run ${schoolName} as ${role === "owner" ? "an owner" : "an admin"}.`,
      "The invitation expires in 7 days.",
    ], { label: "Accept invitation", url }),
};
