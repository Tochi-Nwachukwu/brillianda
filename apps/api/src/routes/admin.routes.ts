import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '@brillianda/db';
import { type ApiResponse } from '@brillianda/types';
import { UserRole } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { authorize } from '../middleware/auth.middleware.js';

const router = Router();
const saltRounds = 12;

router.use(authorize(UserRole.ADMIN));

// GET /api/v1/admin/dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const [students, teachers, classes, subjects, exams] = await Promise.all([
      db.user.count({ where: { tenantId, role: UserRole.STUDENT, isActive: true } }),
      db.user.count({ where: { tenantId, role: UserRole.TEACHER, isActive: true } }),
      db.class.count({ where: { tenantId } }),
      db.subject.count({ where: { tenantId } }),
      db.exam.count({ where: { tenantId } }),
    ]);

    res.json({
      success: true,
      data: { students, teachers, classes, subjects, exams },
    } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/students
router.get('/students', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const students = await db.user.findMany({
      where: { tenantId, role: UserRole.STUDENT },
      include: { studentProfile: { include: { class: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const safeStudents = students.map((s) => {
      const { passwordHash, ...rest } = s;
      return rest;
    });

    res.json({ success: true, data: safeStudents } as ApiResponse<typeof safeStudents>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/students
const createStudentSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  classId: z.string().min(1),
  password: z.string().min(8).optional(),
});

router.post('/students', async (req, res, next) => {
  try {
    const parse = createStudentSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const { email, firstName, lastName, classId, password } = parse.data;
    const tenantId = req.user.tenantId;

    const generatedPassword = password || Math.random().toString(36).slice(-8);
    const passwordHash = await bcrypt.hash(generatedPassword, saltRounds);

    const user = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const newUser = await tx.user.create({
        data: {
          tenantId,
          role: UserRole.STUDENT,
          email,
          passwordHash,
          firstName,
          lastName,
        },
      });

      await tx.studentProfile.create({
        data: {
          userId: newUser.id,
          classId,
        },
      });

      return newUser;
    });

    const { passwordHash: _, ...safeUser } = user;

    res.status(201).json({
      success: true,
      data: { ...safeUser, generatedPassword: password ? undefined : generatedPassword },
    } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/students/bulk
const bulkStudentSchema = z.object({
  students: z
    .array(
      z.object({
        email: z.string().email(),
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        classId: z.string().min(1),
      })
    )
    .max(100),
});

router.post('/students/bulk', async (req, res, next) => {
  try {
    const parse = bulkStudentSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const { students } = parse.data;
    const tenantId = req.user.tenantId;
    const errors: Array<{ row: number; error: string }> = [];
    let created = 0;

    for (let i = 0; i < students.length; i++) {
      const s = students[i];
      try {
        const passwordHash = await bcrypt.hash(Math.random().toString(36).slice(-8), saltRounds);
        await db.$transaction(async (tx: Prisma.TransactionClient) => {
          const newUser = await tx.user.create({
            data: {
              tenantId,
              role: UserRole.STUDENT,
              email: s.email,
              passwordHash,
              firstName: s.firstName,
              lastName: s.lastName,
            },
          });
          await tx.studentProfile.create({
            data: { userId: newUser.id, classId: s.classId },
          });
        });
        created++;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        errors.push({ row: i + 1, error: message });
      }
    }

    res.json({ success: true, data: { created, errors } } as ApiResponse<unknown>);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/admin/students/:id
router.delete('/students/:id', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { id } = req.params;

    await db.user.deleteMany({
      where: { id, tenantId, role: UserRole.STUDENT },
    });

    res.json({ success: true, data: null } as ApiResponse<null>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/teachers
router.get('/teachers', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const teachers = await db.user.findMany({
      where: { tenantId, role: UserRole.TEACHER },
      include: { taughtSubjects: true },
      orderBy: { createdAt: 'desc' },
    });

    const safeTeachers = teachers.map((t: typeof teachers[0]) => {
      const { passwordHash, ...rest } = t;
      return rest;
    });

    res.json({ success: true, data: safeTeachers } as ApiResponse<typeof safeTeachers>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/teachers
const createTeacherSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  subjectIds: z.array(z.string()).optional(),
});

router.post('/teachers', async (req, res, next) => {
  try {
    const parse = createTeacherSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const { email, firstName, lastName, subjectIds } = parse.data;
    const tenantId = req.user.tenantId;
    const passwordHash = await bcrypt.hash(Math.random().toString(36).slice(-8), saltRounds);

    const user = await db.user.create({
      data: {
        tenantId,
        role: UserRole.TEACHER,
        email,
        passwordHash,
        firstName,
        lastName,
        taughtSubjects: subjectIds?.length
          ? { connect: subjectIds.map((id) => ({ id })) }
          : undefined,
      },
      include: { taughtSubjects: true },
    });

    const { passwordHash: _, ...safeUser } = user;
    res.status(201).json({ success: true, data: safeUser } as ApiResponse<typeof safeUser>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/classes
router.get('/classes', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const classes = await db.class.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: classes } as ApiResponse<typeof classes>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/classes
const createClassSchema = z.object({
  name: z.string().min(1),
});

router.post('/classes', async (req, res, next) => {
  try {
    const parse = createClassSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const { name } = parse.data;
    const tenantId = req.user.tenantId;

    const newClass = await db.class.create({
      data: { tenantId, name },
    });

    res.status(201).json({ success: true, data: newClass } as ApiResponse<typeof newClass>);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/admin/classes/:id
router.delete('/classes/:id', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const { id } = req.params;

    await db.class.deleteMany({ where: { id, tenantId } });
    res.json({ success: true, data: null } as ApiResponse<null>);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/subjects
router.get('/subjects', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const subjects = await db.subject.findMany({
      where: { tenantId },
      include: { teacher: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: subjects } as ApiResponse<typeof subjects>);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/subjects
const createSubjectSchema = z.object({
  name: z.string().min(1),
  teacherId: z.string().min(1),
});

router.post('/subjects', async (req, res, next) => {
  try {
    const parse = createSubjectSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const { name, teacherId } = parse.data;
    const tenantId = req.user.tenantId;

    const subject = await db.subject.create({
      data: { tenantId, name, teacherId },
      include: { teacher: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    res.status(201).json({ success: true, data: subject } as ApiResponse<typeof subject>);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/admin/branding
const brandingSchema = z.object({
  logoUrl: z.string().optional(),
  brandColor: z.string().optional(),
});

router.patch('/branding', async (req, res, next) => {
  try {
    const parse = brandingSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parse.error.format(),
      } as ApiResponse<never>);
      return;
    }

    const tenantId = req.user.tenantId;
    const { logoUrl, brandColor } = parse.data;

    const tenant = await db.tenant.update({
      where: { id: tenantId },
      data: { logoUrl, brandColor },
    });

    res.json({ success: true, data: tenant } as ApiResponse<typeof tenant>);
  } catch (err) {
    next(err);
  }
});

export default router;
