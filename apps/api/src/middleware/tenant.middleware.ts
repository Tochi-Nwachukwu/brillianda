import type { Request, Response, NextFunction } from 'express';
import { db } from '@brillianda/db';
import type { ApiResponse } from '@brillianda/types';

export async function resolveTenant(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const subdomain = req.headers['x-tenant-subdomain'] as string | undefined;

    if (!subdomain) {
      res.status(400).json({
        success: false,
        error: 'Tenant subdomain header is required',
      } as ApiResponse<never>);
      return;
    }

    const tenant = await db.tenant.findUnique({
      where: { subdomain },
    });

    if (!tenant || !tenant.isActive) {
      res.status(404).json({
        success: false,
        error: 'Tenant not found',
      } as ApiResponse<never>);
      return;
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
}
