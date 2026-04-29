import jwt from 'jsonwebtoken';
import type { JwtPayload, UserRole } from '@brillianda/types';

export function signToken(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresIn: string = '7d'
): string {
  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyToken(token: string, secret: string): JwtPayload {
  return jwt.verify(token, secret) as JwtPayload;
}

export function decodeToken(token: string): JwtPayload | null {
  try {
    return jwt.decode(token) as JwtPayload | null;
  } catch {
    return null;
  }
}
