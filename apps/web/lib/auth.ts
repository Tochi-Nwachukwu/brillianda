import { jwtDecode } from 'jwt-decode';
import type { JwtPayload } from '@brillianda/types';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('token', token);
  // Also set as cookie so Next.js middleware can read it for route protection
  document.cookie = `token=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
}

export function removeToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('token');
  document.cookie = 'token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

export function decodeToken(): JwtPayload | null {
  const token = getToken();
  if (!token) return null;
  try {
    return jwtDecode<JwtPayload>(token);
  } catch {
    return null;
  }
}

export function isTokenValid(): boolean {
  const payload = decodeToken();
  if (!payload) return false;
  return payload.exp * 1000 > Date.now();
}
