/**
 * Cloudflare Turnstile, checked on the server (the browser token alone proves nothing).
 * Without TURNSTILE_SECRET_KEY outside production, every check passes, so local signup works.
 */
export interface BotCheck {
  verify(token: string | undefined, ip: string | null): Promise<boolean>;
}

export class TurnstileBotCheck implements BotCheck {
  constructor(private readonly secret: string) {}

  async verify(token: string | undefined, ip: string | null): Promise<boolean> {
    if (!token) return false;
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (ip) body.set("remoteip", ip);
    try {
      const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const result = (await res.json()) as { success?: boolean };
      return result.success === true;
    } catch {
      return false; // fail closed
    }
  }
}

export class AllowAllBotCheck implements BotCheck {
  async verify(): Promise<boolean> {
    return true;
  }
}
