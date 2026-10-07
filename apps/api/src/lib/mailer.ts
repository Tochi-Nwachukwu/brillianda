/**
 * Email goes through this interface so the provider is a config choice, not a code change.
 *   ConsoleMailer  development: prints the email (codes, links) to the terminal
 *   MemoryMailer   tests: keeps sent emails for assertions
 *   (next)         Resend / Postmark / SES / ZeptoMail adapter, same interface
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
