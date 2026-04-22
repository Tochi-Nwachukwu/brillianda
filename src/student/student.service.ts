// src/student/student.service.ts
import { prisma } from "../config/prisma.js";
import { Role } from "../prisma/generated/enums.js";

export const createStudent = async (
  schoolUserId: string,
  data: {
    userId: string;
    firstName: string;
    lastName: string;
    enrollmentNo: string;
    dateOfBirth: Date;
    phone?: string;
    address?: string;
    classId?: string;
  }
) => {
  // 1. Get school from logged-in user
  const school = await prisma.school.findUnique({
    where: { userId: schoolUserId },
  });

  if (!school) {
    throw new Error("You must create a school first");
  }

  // 2. Ensure user exists
  const user = await prisma.user.findUnique({
    where: { id: data.userId },
  });

  if (!user) throw new Error("User not found");

  // 3. Ensure correct role
  if (user.role !== Role.STUDENT) {
    throw new Error("User must have STUDENT role");
  }

  // 4. Prevent user already being a student
  const existingStudentUser = await prisma.student.findUnique({
    where: { userId: data.userId },
  });

  if (existingStudentUser) {
    throw new Error("This user is already a student");
  }

  // 5. Prevent duplicate enrollment per school
  const existingEnrollment = await prisma.student.findUnique({
    where: {
      enrollmentNo_schoolId: {
        enrollmentNo: data.enrollmentNo,
        schoolId: school.id,
      },
    },
  });

  if (existingEnrollment) {
    throw new Error("Enrollment number already exists in this school");
  }

  // 6. Validate class belongs to same school (if provided)
  if (data.classId) {
    const cls = await prisma.class.findUnique({
      where: { id: data.classId },
    });

    if (!cls || cls.schoolId !== school.id) {
      throw new Error("Invalid class for this school");
    }
  }

  // 7. Create student
  return await prisma.student.create({
    data: {
      userId: data.userId,
      schoolId: school.id,
      firstName: data.firstName,
      lastName: data.lastName,
      enrollmentNo: data.enrollmentNo,
      dateOfBirth: data.dateOfBirth,
      phone: data.phone ?? null,
      address: data.address ?? null,
      classId: data.classId ?? null,
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
        },
      },
      class: true,
    },
  });
};