import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN || 'brillianda.com';
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const host = request.headers.get('host') || '';

  // Extract subdomain
  let subdomain: string | null = null;

  if (host !== 'localhost' && host !== `www.${BASE_DOMAIN}` && host !== BASE_DOMAIN) {
    if (host.endsWith(`.${BASE_DOMAIN}`)) {
      subdomain = host.slice(0, -BASE_DOMAIN.length - 1);
    }
  }

  // If no subdomain, serve marketing site normally
  if (!subdomain) {
    return NextResponse.next();
  }

  // Verify tenant exists
  try {
    const res = await fetch(`${API_URL}/api/v1/public/tenant/${subdomain}`, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      const url = new URL(`https://${BASE_DOMAIN}`);
      url.searchParams.set('error', 'invalid-school');
      return NextResponse.redirect(url);
    }
  } catch {
    const url = new URL(`https://${BASE_DOMAIN}`);
    url.searchParams.set('error', 'invalid-school');
    return NextResponse.redirect(url);
  }

  // Set tenant cookie and header
  const response = NextResponse.next();
  response.cookies.set('tenant_subdomain', subdomain, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
  });
  response.headers.set('X-Tenant-Subdomain', subdomain);

  // Auth & role protection for dashboard routes
  if (pathname.startsWith('/admin') || pathname.startsWith('/teacher') || pathname.startsWith('/student')) {
    const token = request.cookies.get('token')?.value;

    if (!token) {
      const url = new URL('/login', request.url);
      return NextResponse.redirect(url);
    }

    // Basic role check via JWT payload (no verification needed here, backend does that)
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64').toString()
      );
      const role = payload.role;

      if (pathname.startsWith('/admin') && role !== 'ADMIN') {
        return NextResponse.redirect(new URL('/', request.url));
      }
      if (pathname.startsWith('/teacher') && role !== 'TEACHER' && role !== 'ADMIN') {
        return NextResponse.redirect(new URL('/', request.url));
      }
      if (pathname.startsWith('/student') && role !== 'STUDENT') {
        return NextResponse.redirect(new URL('/', request.url));
      }
    } catch {
      const url = new URL('/login', request.url);
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
