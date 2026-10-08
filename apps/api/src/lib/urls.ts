import type { AppConfig } from "../context.js";

/** Public URLs the API puts in emails and handover responses. Always built from config, never from input. */
export function apexUrl(config: AppConfig, path = "/"): string {
  return `${config.protocol}://${config.rootDomain}${portSuffix(config)}${path}`;
}

/**
 * A school's own address. Where schools are addressed with ?school= (a staging host without
 * wildcard subdomains, e.g. *.vercel.app), links become https://host/path?school=<subdomain>.
 */
export function schoolUrl(config: AppConfig, subdomain: string, path = "/"): string {
  if (config.allowSchoolQueryParam) {
    const url = new URL(`${config.protocol}://${config.rootDomain}${portSuffix(config)}${path}`);
    url.searchParams.set("school", subdomain);
    return url.toString();
  }
  return `${config.protocol}://${subdomain}.${config.rootDomain}${portSuffix(config)}${path}`;
}

function portSuffix(config: AppConfig): string {
  return config.publicPort ? `:${config.publicPort}` : "";
}

/** "ngozi@example.com" → "ng•••@example.com", for showing where a code was sent. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(local.length - 2, 3)))}@${domain}`;
}
