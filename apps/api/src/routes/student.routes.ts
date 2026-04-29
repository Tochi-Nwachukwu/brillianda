import { Router } from 'express';
import { z } from 'zod';
import { db } from '@brillianda/db';
import { type ApiResponse } from '@brillianda/types';
import { UserRole, ExamStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { authorize } from '../middleware/auth.middleware.js';

const router = Router();
router.use(authorize(UserRole.STUDENT));

// GET /api/v1/student/dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenantId;

    const studentProfile = await db.studentProfile.findUnique({
      where: { userId },
      include: { class: true },
    });

    const now = new Date();

    const upcomingExams = await db.exam.findMany({
      where: {
        tenantId,
        status: ExamStatus.PUBLISHED,
        OR: [
          { startTime: { lte: now }, endTime: { gte: now } },
          { startTime: null, endTime: null },
          { startTime: { lte: now }, endTime: null },
          { startTime: null, endTime: { gte: now } },
        ],
      },
      include: { subject: true },
      orderBy: { startTime: 'asc' },
      take: 5,
    });

    const completedAttempts = await db.examAttempt.findMany({
      where: { studentId: userId, isSubmitted: true },
      include: {
        exam: {
          select: {
            id: true,
            title: true,
            showResultsImmediately: true,
            subject: { select: { name: true } },
          },
        },
      },
      orderBy: { completedAt: 'desc' },
      take: 5,
    });

    res.json({
      success: true,
      data: {
        classInfo: studentProfile?.class ?? null,
        upcomingExams,
        completedAttempts,
      },
    } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/student/exams/:id
router.get('/exams/:id', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenantId;
    const { id } = req.params;

    const exam = await db.exam.findFirst({
      where: { id, tenantId, status: ExamStatus.PUBLISHED },
      include: {
        subject: true,
        questions: {
          orderBy: { order: 'asc' },
          include: {
            options: {
              orderBy: { order: 'asc' },
              select: { id: true, text: true, order: true },
            },
          },
        },
      },
    });

    if (!exam) {
      res.status(404).json({ success: false, error: 'Exam not found' } as ApiResponse<never>);
      return;
    }

    const attempt = await db.examAttempt.findUnique({
      where: { studentId_examId: { studentId: userId, examId: id } },
    });

    res.json({ success: true, data: { exam, attempt } } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/student/exams/:id/start
router.post('/exams/:id/start', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const tenantId = req.user.tenantId;
    const { id } = req.params;

    const exam = await db.exam.findFirst({
      where: { id, tenantId, status: ExamStatus.PUBLISHED },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: {
            options: {
              orderBy: { order: 'asc' },
              select: { id: true, text: true, order: true },
            },
          },
        },
      },
    });

    if (!exam) {
      res.status(404).json({ success: false, error: 'Exam not found or not published' } as ApiResponse<never>);
      return;
    }

    const existingAttempt = await db.examAttempt.findUnique({
      where: { studentId_examId: { studentId: userId, examId: id } },
    });

    if (existingAttempt?.isSubmitted) {
      res.status(409).json({
        success: false,
        error: 'You have already completed this exam',
      } as ApiResponse<never>);
      return;
    }

    let attempt = existingAttempt;
    if (!attempt) {
      attempt = await db.examAttempt.create({
        data: {
          studentId: userId,
          examId: id,
          startTime: new Date(),
        },
      });
    }

    // Shuffle options for each question
    const shuffledQuestions = exam.questions.map((q: typeof exam.questions[number]) => ({
      ...q,
      options: q.options.sort(() => Math.random() - 0.5),
    }));

    res.json({
      success: true,
      data: {
        attemptId: attempt.id,
        questions: shuffledQuestions,
        durationMinutes: exam.durationMinutes,
        startTime: attempt.startTime,
      },
    } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/student/exams/:id/submit
const submitSchema = z.object({
  attemptId: z.string().min(1),
  answers: z.array(
    z.object({
      questionId: z.string().min(1),
      selectedOptionId: z.string().nullable(),
    })
  ),
});

router.post('/exams/:id/submit', async (req, res, next) => {
  try {
    const parse = submitSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const { attemptId, answers } = parse.data;
    const userId = req.user.id;
    const tenantId = req.user.tenantId;
    const { id: examId } = req.params;

    const attempt = await db.examAttempt.findFirst({
      where: { id: attemptId, studentId: userId, examId },
      include: { exam: true },
    });

    if (!attempt) {
      res.status(404).json({ success: false, error: 'Attempt not found' } as ApiResponse<never>);
      return;
    }

    if (attempt.isSubmitted) {
      res.status(409).json({
        success: false,
        error: 'Attempt already submitted',
      } as ApiResponse<never>);
      return;
    }

    const questions = await db.question.findMany({
      where: { examId },
      include: { options: true },
    });

    const optionMap = new Map<string, { isCorrect: boolean; questionId: string }>();
    for (const q of questions) {
      for (const o of q.options) {
        optionMap.set(o.id, { isCorrect: o.isCorrect, questionId: q.id });
      }
    }

    let score = 0;
    let maxScore = 0;
    const answerRecords: Array<{
      questionId: string;
      selectedOptionId: string | null;
      isCorrect: boolean | null;
    }> = [];

    for (const q of questions) {
      maxScore += q.points;
      const answer = answers.find((a) => a.questionId === q.id);
      const selectedOptionId = answer?.selectedOptionId ?? null;
      const isCorrect = selectedOptionId ? optionMap.get(selectedOptionId)?.isCorrect ?? false : false;
      if (isCorrect) score += q.points;
      answerRecords.push({ questionId: q.id, selectedOptionId, isCorrect });
    }

    const updatedAttempt = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const record of answerRecords) {
        await tx.studentAnswer.create({
          data: {
            attemptId,
            questionId: record.questionId,
            selectedOptionId: record.selectedOptionId,
            isCorrect: record.isCorrect,
          },
        });
      }

      return tx.examAttempt.update({
        where: { id: attemptId },
        data: {
          isSubmitted: true,
          completedAt: new Date(),
          score,
          maxScore,
        },
        include: {
          exam: { select: { showResultsImmediately: true } },
          answers: { include: { question: true } },
        },
      });
    });

    if (attempt.exam.showResultsImmediately) {
      res.json({
        success: true,
        data: {
          score,
          maxScore,
          percentage: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
          answers: updatedAttempt.answers,
        },
      } as ApiResponse<unknown>);
    } else {
      res.json({
        success: true,
        data: { message: 'Exam submitted successfully. Results will be available soon.' },
      } as ApiResponse<unknown>);
    }
  } catch (err) {
    next(err);
  }
});

export default router;
