/**
 * Text messages go through this interface so the provider is a config choice, like email.
 *   ConsoleSms   development: prints the text to the terminal (or the host's logs)
 *   MemorySms    tests: keeps sent texts for assertions
 *   TermiiSms    staging / production (SMS_PROVIDER=termii)
 *   OutboxSms    staging (MAIL_OUTBOX_KEY): keeps a copy in the staging outbox, then tries the provider
 */
import { smsCount } from "@brillianda/core";
import { emailOutbox, eq, type Database } from "@brillianda/db";
import type { Logger } from "./logger.js";

export interface SmsMessage {
  /** E.164: +2348030000001. */
  to: string;
  text: string;
  /** For logs: "birthday". */
  tag: string;
}

export interface Sms {
  /** Resolves with the provider's message id (or null), or throws SmsDeliveryError. */
  send(message: SmsMessage): Promise<{ ref: string | null }>;
}

/** Thrown when the provider refuses or cannot be reached. Never carries the API key. */
export class SmsDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "SmsDeliveryError";
  }
}

export class ConsoleSms implements Sms {
  constructor(private readonly logger: Logger) {}

  async send(m: SmsMessage): Promise<{ ref: string | null }> {
    process.stdout.write(`\n💬 ${m.tag} → ${m.to}\n${m.text}\n\n`);
    this.logger.debug("sms (console)", { to: m.to, tag: m.tag });
    return { ref: null };
  }
}

export class MemorySms implements Sms {
  readonly sent: SmsMessage[] = [];
  /** Numbers that fail, for testing failures. */
  readonly failing = new Set<string>();

  async send(m: SmsMessage): Promise<{ ref: string | null }> {
    if (this.failing.has(m.to)) throw new SmsDeliveryError("Refused (test)", 400);
    this.sent.push(m);
    return { ref: `test-${this.sent.length}` };
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Termii (developer.termii.com/messaging-api), over plain fetch: no SDK dependency. Each Termii
 * account has its own base URL, shown on its dashboard. The `dnd` channel reaches numbers on
 * Do-Not-Disturb (most Nigerian lines) and must be activated on the account; `generic` doesn't.
 * Texts with letters outside GSM-7 (ọ, ẹ, curly quotes) go as Unicode, 70 characters a text.
 */
export class TermiiSms implements Sms {
  constructor(
    private readonly opts: { apiKey: string; senderId: string; baseUrl: string; channel: "dnd" | "generic" },
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(m: SmsMessage): Promise<{ ref: string | null }> {
    const body = JSON.stringify({
      api_key: this.opts.apiKey,
      to: m.to.replace(/^\+/, ""),
      from: this.opts.senderId,
      sms: m.text,
      type: smsCount(m.text).unicode ? "unicode" : "plain",
      channel: this.opts.channel,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, "")}/api/sms/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new SmsDeliveryError(`Termii unreachable: ${(err as Error).message}`, null);
    }
    const reply = (await res.json().catch(() => ({}))) as { code?: string; message?: string; message_id?: string | number; message_id_str?: string };
    if (res.ok && (reply.code === undefined || reply.code === "ok")) {
      const ref = reply.message_id_str ?? (reply.message_id === undefined ? null : String(reply.message_id));
      this.logger.info("sms sent", { provider: "termii", tag: m.tag, ref });
      return { ref };
    }
    this.logger.error("sms failed", { provider: "termii", tag: m.tag, status: res.status, reason: reply.message });
    throw new SmsDeliveryError(`Termii ${res.status}: ${reply.message ?? res.statusText}`, res.status);
  }
}

/**
 * Staging only (MAIL_OUTBOX_KEY): keeps a copy of every text in the staging outbox (the email
 * outbox, tagged sms_<tag>, "to" the number), then tries the real provider. If the provider
 * refuses or none is set up, the text still counts as sent there, for testers to read.
 */
export class OutboxSms implements Sms {
  constructor(
    private readonly db: Database,
    private readonly inner: Sms | null,
    private readonly logger: Logger,
  ) {}

  async send(m: SmsMessage): Promise<{ ref: string | null }> {
    const [row] = await this.db
      .insert(emailOutbox)
      .values({ to: m.to, tag: `sms_${m.tag}`, subject: `Text to ${m.to}`, text: m.text, html: "" })
      .returning({ id: emailOutbox.id });
    if (!this.inner) return { ref: null };
    try {
      const sent = await this.inner.send(m);
      await this.db.update(emailOutbox).set({ delivered: true }).where(eq(emailOutbox.id, row!.id));
      return sent;
    } catch (err) {
      this.logger.warn("text kept in the staging outbox only", { tag: m.tag, reason: (err as Error).message });
      return { ref: null };
    }
  }
}
