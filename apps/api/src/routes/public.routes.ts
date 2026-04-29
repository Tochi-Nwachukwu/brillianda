import { Router } from 'express';
import { db } from '@brillianda/db';
import type { ApiResponse } from '@brillianda/types';

const router = Router();

// GET /api/v1/public/tenant/:subdomain
router.get('/tenant/:subdomain', async (req, res, next) => {
  try {
    const { subdomain } = req.params;
    const tenant = await db.tenant.findUnique({
      where: { subdomain },
      select: {
        id: true,
        name: true,
        subdomain: true,
        logoUrl: true,
        brandColor: true,
        isActive: true,
      },
    });

    if (!tenant || !tenant.isActive) {
      res.status(404).json({
        success: false,
        error: 'Tenant not found',
      } as ApiResponse<never>);
      return;
    }

    res.json({ success: true, data: tenant } as ApiResponse<typeof tenant>);
  } catch (err) {
    next(err);
  }
});

export default router;
