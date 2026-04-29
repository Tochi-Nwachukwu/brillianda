import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { Prisma } from '@prisma/client';
import { type ApiResponse } from '@brillianda/types';

import { resolveTenant } from './middleware/tenant.middleware.js';
import { authenticate } from './middleware/auth.middleware.js';

import publicRouter from './routes/public.routes.js';
import authRouter from './routes/auth.routes.js';
import adminRouter from './routes/admin.routes.js';
import teacherRouter from './routes/teacher.routes.js';
import studentRouter from './routes/student.routes.js';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'];

app.use(helmet());
app.use(
  cors({
    origin: ALLOWED_ORIGINS.map((o) => o.trim()),
    credentials: true,
  })
);
app.use(express.json());
app.use(morgan('dev'));

// Public routes (no tenant resolution required for register-school)
app.use('/api/v1/public', publicRouter);

// Apply tenant resolution to all other /api/v1/* routes
app.use('/api/v1', resolveTenant);

// Auth routes (tenant resolved, some authenticated)
app.use('/api/v1/auth', authRouter);

// Protected role-based routes
app.use('/api/v1/admin', authenticate, adminRouter);
app.use('/api/v1/teacher', authenticate, teacherRouter);
app.use('/api/v1/student', authenticate, studentRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  } as ApiResponse<never>);
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Global error:', err);

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const prismaErr = err as Prisma.PrismaClientKnownRequestError;
    if (prismaErr.code === 'P2002') {
      res.status(409).json({
        success: false,
        error: 'Unique constraint violation',
      } as ApiResponse<never>);
      return;
    }
    if (prismaErr.code === 'P2025') {
      res.status(404).json({
        success: false,
        error: 'Record not found',
      } as ApiResponse<never>);
      return;
    }
  }

  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error',
  } as ApiResponse<never>);
});

app.listen(PORT, () => {
  console.log(`🚀 API server running on http://localhost:${PORT}`);
});
