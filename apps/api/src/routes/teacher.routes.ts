import { Router } from 'express';
import { z } from 'zod';
import { db } from '@brillianda/db';
import { type ApiResponse } from '@brillianda/types';
import { UserRole, ExamStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { authorize } from '../middleware/auth.middleware.js';

const router = Router();
router.use(authorize(UserRole.TEACHER, UserRole.ADMIN));

// GET /api/v1/teacher/dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenantId;

    const [subjects, upcomingExams, recentAttempts] = await Promise.all([
      db.subject.findMany({
        where: { tenantId, teacherId: userId },
        select: { id: true, name: true },
      }),
      db.exam.findMany({
        where: {
          tenantId,
          teacherId: userId,
          status: ExamStatus.PUBLISHED,
        },
        orderBy: { startTime: 'asc' },
        take: 5,
        select: { id: true, title: true, startTime: true, endTime: true, status: true },
      }),
      db.examAttempt.findMany({
        where: {
          exam: { tenantId, teacherId: userId },
        },
        orderBy: { startTime: 'desc' },
        take: 10,
        include: {
          student: { select: { firstName: true, lastName: true, email: true } },
          exam: { select: { title: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: { subjects, upcomingExams, recentAttempts },
    } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/teacher/exams
router.get('/exams', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user.id;

    const exams = await db.exam.findMany({
      where: { tenantId, teacherId: userId },
      include: {
        subject: { select: { id: true, name: true } },
        _count: { select: { attempts: true, questions: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: exams } as ApiResponse<typeof exams>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/teacher/exams
const createExamSchema = z.object({
  title: z.string().min(1),
  subjectId: z.string().min(1),
  durationMinutes: z.number().int().min(1),
  instructions: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  showResultsImmediately: z.boolean().optional(),
  questions: z.array(
    z.object({
      text: z.string().min(1),
      points: z.number().int().min(1),
      order: z.number().int(),
      options: z.array(
        z.object({
          text: z.string().min(1),
          isCorrect: z.boolean(),
          order: z.number().int(),
        })
      ),
    })
  ),
});

router.post('/exams', async (req, res, next) => {
  try {
    const parse = createExamSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const data = parse.data;
    const tenantId = req.user.tenantId;
    const teacherId = req.user.id;

    for (const q of data.questions) {
      const correctCount = q.options.filter((o) => o.isCorrect).length;
      if (correctCount !== 1) {
        res.status(400).json({
          success: false,
          error: `Question "${q.text}" must have exactly one correct option`,
        } as ApiResponse<never>);
        return;
      }
    }

    const exam = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const newExam = await tx.exam.create({
        data: {
          tenantId,
          subjectId: data.subjectId,
          teacherId,
          title: data.title,
          instructions: data.instructions,
          durationMinutes: data.durationMinutes,
          startTime: data.startTime ? new Date(data.startTime) : null,
          endTime: data.endTime ? new Date(data.endTime) : null,
          showResultsImmediately: data.showResultsImmediately ?? true,
          questions: {
            create: data.questions.map((q) => ({
              text: q.text,
              points: q.points,
              order: q.order,
              options: {
                create: q.options.map((o) => ({
                  text: o.text,
                  isCorrect: o.isCorrect,
                  order: o.order,
                })),
              },
            })),
          },
        },
        include: { questions: { include: { options: true } }, subject: true },
      });
      return newExam;
    });

    res.status(201).json({ success: true, data: exam } as ApiResponse<typeof exam>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/teacher/exams/:id
router.get('/exams/:id', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const teacherId = req.user.id;
    const { id } = req.params;

    const exam = await db.exam.findFirst({
      where: { id, tenantId, teacherId },
      include: {
        subject: true,
        questions: { include: { options: true }, orderBy: { order: 'asc' } },
        attempts: {
          include: {
            student: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    });

    if (!exam) {
      res.status(404).json({ success: false, error: 'Exam not found' } as ApiResponse<never>);
      return;
    }

    res.json({ success: true, data: exam } as ApiResponse<typeof exam>);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/teacher/exams/:id
const updateExamSchema = z.object({
  title: z.string().min(1).optional(),
  subjectId: z.string().min(1).optional(),
  durationMinutes: z.number().int().min(1).optional(),
  instructions: z.string().optional().nullable(),
  startTime: z.string().datetime().optional().nullable(),
  endTime: z.string().datetime().optional().nullable(),
  showResultsImmediately: z.boolean().optional(),
  questions: z
    .array(
      z.object({
        text: z.string().min(1),
        points: z.number().int().min(1),
        order: z.number().int(),
        options: z.array(
          z.object({
            text: z.string().min(1),
            isCorrect: z.boolean(),
            order: z.number().int(),
          })
        ),
      })
    )
    .optional(),
});

router.patch('/exams/:id', async (req, res, next) => {
  try {
    const parse = updateExamSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const data = parse.data;
    const tenantId = req.user.tenantId;
    const teacherId = req.user.id;
    const { id } = req.params;

    const existing = await db.exam.findFirst({
      where: { id, tenantId, teacherId },
      include: { attempts: true },
    });

    if (!existing) {
      res.status(404).json({ success: false, error: 'Exam not found' } as ApiResponse<never>);
      return;
    }

    if (existing.attempts.length > 0) {
      res.status(409).json({
        success: false,
        error: 'Cannot update exam that has active attempts',
      } as ApiResponse<never>);
      return;
    }

    if (data.questions) {
      for (const q of data.questions) {
        const correctCount = q.options.filter((o) => o.isCorrect).length;
        if (correctCount !== 1) {
          res.status(400).json({
            success: false,
            error: `Question "${q.text}" must have exactly one correct option`,
          } as ApiResponse<never>);
          return;
        }
      }
    }

    const updated = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      if (data.questions) {
        await tx.question.deleteMany({ where: { examId: id } });
      }

      const exam = await tx.exam.update({
        where: { id },
        data: {
          title: data.title,
          subjectId: data.subjectId,
          durationMinutes: data.durationMinutes,
          instructions: data.instructions,
          startTime: data.startTime ? new Date(data.startTime) : data.startTime === null ? null : undefined,
          endTime: data.endTime ? new Date(data.endTime) : data.endTime === null ? null : undefined,
          showResultsImmediately: data.showResultsImmediately,
          questions: data.questions
            ? {
                create: data.questions.map((q) => ({
                  text: q.text,
                  points: q.points,
                  order: q.order,
                  options: {
                    create: q.options.map((o) => ({
                      text: o.text,
                      isCorrect: o.isCorrect,
                      order: o.order,
                    })),
                  },
                })),
              }
            : undefined,
        },
        include: { questions: { include: { options: true } }, subject: true },
      });
      return exam;
    });

    res.json({ success: true, data: updated } as ApiResponse<typeof updated>);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/teacher/exams/:id/publish
router.patch('/exams/:id/publish', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const teacherId = req.user.id;
    const { id } = req.params;

    const exam = await db.exam.findFirst({
      where: { id, tenantId, teacherId },
      include: { questions: { include: { options: true } } },
    });

    if (!exam) {
      res.status(404).json({ success: false, error: 'Exam not found' } as ApiResponse<never>);
      return;
    }

    if (exam.questions.length < 1) {
      res.status(400).json({
        success: false,
        error: 'Exam must have at least 1 question',
      } as ApiResponse<never>);
      return;
    }

    for (const q of exam.questions) {
      if (q.options.length < 2) {
        res.status(400).json({
          success: false,
          error: `Question "${q.text}" must have at least 2 options`,
        } as ApiResponse<never>);
        return;
      }
    }

    const updated = await db.exam.update({
      where: { id },
      data: { status: ExamStatus.PUBLISHED },
    });

    res.json({ success: true, data: updated } as ApiResponse<typeof updated>);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/teacher/exams/:id/close
router.patch('/exams/:id/close', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const teacherId = req.user.id;
    const { id } = req.params;

    const exam = await db.exam.findFirst({
      where: { id, tenantId, teacherId },
    });

    if (!exam) {
      res.status(404).json({ success: false, error: 'Exam not found' } as ApiResponse<never>);
      return;
    }

    const updated = await db.exam.update({
      where: { id },
      data: { status: ExamStatus.CLOSED },
    });

    res.json({ success: true, data: updated } as ApiResponse<typeof updated>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/teacher/exams/:id/results
router.get('/exams/:id/results', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const teacherId = req.user.id;
    const { id } = req.params;

    const attempts = await db.examAttempt.findMany({
      where: { examId: id, exam: { tenantId, teacherId } },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { startTime: 'desc' },
    });

    const scores = attempts.filter((a: typeof attempts[number]) => a.score !== null).map((a: typeof attempts[number]) => a.score!);
    const averageScore = scores.length > 0 ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : 0;
    const highestScore = scores.length > 0 ? Math.max(...scores) : 0;
    const lowestScore = scores.length > 0 ? Math.min(...scores) : 0;
    const submittedCount = attempts.filter((a: typeof attempts[number]) => a.isSubmitted).length;
    const pendingCount = attempts.filter((a: typeof attempts[number]) => !a.isSubmitted).length;

    res.json({
      success: true,
      data: {
        attempts,
        stats: {
          averageScore,
          highestScore,
          lowestScore,
          submittedCount,
          pendingCount,
        },
      },
    } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

export default router;
