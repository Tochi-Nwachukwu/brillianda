import type { Request, Response, NextFunction } from 'express';
import { db } from '@brillianda/db';
import { verifyToken } from '@brillianda/utils';
import { type ApiResponse } from '@brillianda/types';
import { UserRole } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET!;

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: missing or invalid token',
      } as ApiResponse<never>);
      return;
    }

    const token = authHeader.slice(7);
    const decoded = verifyToken(token, JWT_SECRET);

    if (decoded.tenantId !== req.tenant.id) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: cross-tenant access denied',
      } as ApiResponse<never>);
      return;
    }

    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      include: { tenant: true },
    });

    if (!user || !user.isActive) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: user not found or inactive',
      } as ApiResponse<never>);
      return;
    }

    req.user = user as Request['user'];
    next();
  } catch (err) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized: invalid token',
    } as ApiResponse<never>);
  }
}

export function authorize(...roles: UserRole[]) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
      } as ApiResponse<never>);
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: insufficient permissions',
      } as ApiResponse<never>);
      return;
    }

    next();
  };
}
