import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '@brillianda/db';
import { signToken } from '@brillianda/utils';
import { type ApiResponse } from '@brillianda/types';
import { UserRole } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const saltRounds = 12;

const registerSchoolSchema = z.object({
  schoolName: z.string().min(2),
  subdomain: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Subdomain must be lowercase alphanumeric with hyphens only'),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  adminFirstName: z.string().min(1),
  adminLastName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /api/v1/public/register-school
router.post('/register-school', async (req, res, next) => {
  try {
    const parse = registerSchoolSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const {
      schoolName,
      subdomain,
      adminEmail,
      adminPassword,
      adminFirstName,
      adminLastName,
    } = parse.data;

    const passwordHash = await bcrypt.hash(adminPassword, saltRounds);

    const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const tenant = await tx.tenant.create({
        data: {
          name: schoolName,
          subdomain,
          contactEmail: adminEmail,
        },
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          role: UserRole.ADMIN,
          email: adminEmail,
          passwordHash,
          firstName: adminFirstName,
          lastName: adminLastName,
        },
      });

      return { tenant, user };
    });

    const token = signToken(
      {
        userId: result.user.id,
        tenantId: result.tenant.id,
        role: result.user.role as import('@brillianda/types').UserRole,
        email: result.user.email,
      },
      JWT_SECRET,
      JWT_EXPIRES_IN
    );

    res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          role: result.user.role,
          tenantId: result.tenant.id,
        },
      },
    } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const parse = loginSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const { email, password } = parse.data;
    const tenantId = req.tenant.id;

    const user = await db.user.findUnique({
      where: { tenantId_email: { tenantId, email } },
    });

    if (!user || !user.isActive) {
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      } as ApiResponse<never>);
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      } as ApiResponse<never>);
      return;
    }

    const token = signToken(
      {
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role as import('@brillianda/types').UserRole,
        email: user.email,
      },
      JWT_SECRET,
      JWT_EXPIRES_IN
    );

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          tenantId: user.tenantId,
        },
      },
    } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await db.user.findUnique({
      where: { id: req.user.id },
      include: {
        tenant: true,
        studentProfile: { include: { class: true } },
        taughtSubjects: true,
      },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      } as ApiResponse<never>);
      return;
    }

    const { passwordHash, ...safeUser } = user;
    res.json({ success: true, data: safeUser } as ApiResponse<typeof safeUser>);
  } catch (err) {
    next(err);
  }
});

export default router;
