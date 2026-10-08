/**
 * Email goes through this interface so the provider is a config choice, not a code change.
 *   ConsoleMailer  development: prints the email (codes, links) to the terminal
 *   MemoryMailer   tests: keeps sent emails for assertions
 *   ResendMailer   staging / production (MAIL_PROVIDER=resend)
 *   Another provider later (Postmark / SES / ZeptoMail) is one more class with the same interface.
 */
import type { Logger } from "./logger.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** For logs and provider analytics: "signup_code", "login_link", ... */
  tag: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  async send(m: EmailMessage): Promise<void> {
    const line = "─".repeat(64);
    process.stdout.write(`\n${line}\n📧 ${m.tag} → ${m.to}\n${m.subject}\n\n${m.text}\n${line}\n\n`);
    this.logger.debug("email (console)", { to: m.to, tag: m.tag });
  }
}

export class MemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];

  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
  }

  last(to?: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to.toLowerCase() === to.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Thrown when the provider refuses or cannot be reached. Never carries the API key. */
export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "MailDeliveryError";
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Resend (https://resend.com/docs/api-reference/emails/send-email), over plain fetch: no SDK dependency.
 * Retries once on 429 / 5xx / network failure; anything else (bad sender, unverified domain) fails at once.
 *
 * Testing without a domain: MAIL_FROM="Brillianda <onboarding@resend.dev>" sends only to the address the
 * Resend account was opened with. Any other recipient gets 403; that is Resend's rule, not a bug here.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly retryDelayMs = 500,
  ) {}

  async send(m: EmailMessage): Promise<void> {
    const body = JSON.stringify({
      from: this.from,
      to: [m.to],
      subject: m.subject,
      text: m.text,
      html: m.html,
      // Resend tag values allow only letters, digits, _ and -.
      tags: [{ name: "category", value: m.tag.replace(/[^A-Za-z0-9_-]/g, "_") }],
    });

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        if (attempt < 2) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new MailDeliveryError(`Resend unreachable: ${(err as Error).message}`, null);
      }

      if (res.ok) {
        const { id } = (await res.json().catch(() => ({}))) as { id?: string };
        this.logger.info("email sent", { provider: "resend", tag: m.tag, id });
        return;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < 2) {
        await sleep(this.retryDelayMs);
        continue;
      }
      const detail = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
      this.logger.error("email failed", { provider: "resend", tag: m.tag, status: res.status, reason: detail.message });
      throw new MailDeliveryError(`Resend ${res.status}: ${detail.message ?? res.statusText}`, res.status);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
