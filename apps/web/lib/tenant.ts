export function getSubdomain(): string | null {
  if (typeof window === 'undefined') return null;
  const host = window.location.hostname;
  const baseDomain = process.env.NEXT_PUBLIC_BASE_DOMAIN || 'brillianda.com';

  if (host === 'localhost' || host === baseDomain || host === `www.${baseDomain}`) {
    return null;
  }

  if (host.endsWith(`.${baseDomain}`)) {
    return host.slice(0, -baseDomain.length - 1);
  }

  return null;
}

export function getTenantFromCookie(): string | null {
  if (typeof window === 'undefined') return null;
  const match = document.cookie.match(/tenant_subdomain=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
