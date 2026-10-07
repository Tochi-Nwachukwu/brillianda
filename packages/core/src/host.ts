import { normaliseSubdomain, validateSubdomain } from "./subdomain.js";

/**
 * What an incoming host means. The school is ALWAYS derived from the host,
 * never from a header, body field or query param the browser controls
 * (the preview-only ?school= escape hatch is handled by the caller behind a flag).
 */
export type HostTarget =
  | { kind: "apex" }
  | { kind: "school"; subdomain: string }
  | { kind: "unknown" };

const APEX_ALIASES = new Set(["www"]);

/** Strips the port and a trailing dot, lowercases. Returns "" for garbage. */
export function normaliseHost(rawHost: string | null | undefined): string {
  if (!rawHost) return "";
  let host = rawHost.trim().toLowerCase();
  // IPv6 literals are never school hosts.
  if (host.startsWith("[")) return "";
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  return host;
}

export function resolveHost(rawHost: string | null | undefined, rootDomain: string): HostTarget {
  const host = normaliseHost(rawHost);
  const root = normaliseHost(rootDomain);
  if (!host || !root) return { kind: "unknown" };
  if (host === root) return { kind: "apex" };

  const suffix = `.${root}`;
  if (!host.endsWith(suffix)) return { kind: "unknown" };

  const label = host.slice(0, -suffix.length);
  // Exactly one label: a.b.brillianda.com is not a school.
  if (!label || label.includes(".")) return { kind: "unknown" };
  if (APEX_ALIASES.has(label)) return { kind: "apex" };

  const subdomain = normaliseSubdomain(label);
  // Reserved names (api, admin, ...) are not schools either.
  if (!validateSubdomain(subdomain).ok) return { kind: "unknown" };
  return { kind: "school", subdomain };
}
