import { PrismaClient, UserRole, ExamStatus, QuestionType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const saltRounds = 12;

  // 1. Create demo Tenant
  const tenant = await prisma.tenant.upsert({
    where: { subdomain: 'demo' },
    update: {},
    create: {
      name: 'Demo School',
      subdomain: 'demo',
      contactEmail: 'admin@demo.com',
      brandColor: '#0A1F44',
    },
  });

  // 2. Create ADMIN user
  const adminPassword = await bcrypt.hash('Demo1234!', saltRounds);
  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'admin@demo.com' } },
    update: {},
    create: {
      tenantId: tenant.id,
      role: UserRole.ADMIN,
      email: 'admin@demo.com',
      passwordHash: adminPassword,
      firstName: 'Admin',
      lastName: 'User',
    },
  });

  // 3. Create TEACHER user
  const teacherPassword = await bcrypt.hash('Teacher123!', saltRounds);
  const teacher = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'teacher@demo.com' } },
    update: {},
    create: {
      tenantId: tenant.id,
      role: UserRole.TEACHER,
      email: 'teacher@demo.com',
      passwordHash: teacherPassword,
      firstName: 'John',
      lastName: 'Doe',
    },
  });

  // 4. Create 3 STUDENT users
  const studentData = [
    { email: 'student1@demo.com', firstName: 'Alice', lastName: 'Smith' },
    { email: 'student2@demo.com', firstName: 'Bob', lastName: 'Jones' },
    { email: 'student3@demo.com', firstName: 'Charlie', lastName: 'Brown' },
  ];

  const students = await Promise.all(
    studentData.map(async (s, i) => {
      const password = await bcrypt.hash(`Student${i + 1}123!`, saltRounds);
      return prisma.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: s.email } },
        update: {},
        create: {
          tenantId: tenant.id,
          role: UserRole.STUDENT,
          email: s.email,
          passwordHash: password,
          firstName: s.firstName,
          lastName: s.lastName,
        },
      });
    })
  );

  // 5. Create 2 Classes
  const class10 = await prisma.class.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Grade 10' } },
    update: {},
    create: { tenantId: tenant.id, name: 'Grade 10' },
  });

  const class11 = await prisma.class.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Grade 11' } },
    update: {},
    create: { tenantId: tenant.id, name: 'Grade 11' },
  });

  // 6. Create StudentProfiles linking students to classes
  await Promise.all(
    students.map((student, i) =>
      prisma.studentProfile.upsert({
        where: { userId: student.id },
        update: {},
        create: {
          userId: student.id,
          classId: i < 2 ? class10.id : class11.id,
        },
      })
    )
  );

  // 7. Create 2 Subjects assigned to the teacher
  const math = await prisma.subject.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'Mathematics' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Mathematics',
      teacherId: teacher.id,
    },
  });

  const english = await prisma.subject.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'English' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'English',
      teacherId: teacher.id,
    },
  });

  // 8. Create 1 published Exam with 5 multiple-choice questions
  const exam = await prisma.exam.upsert({
    where: {
      id: 'demo-exam-math-001',
    },
    update: {},
    create: {
      id: 'demo-exam-math-001',
      tenantId: tenant.id,
      subjectId: math.id,
      teacherId: teacher.id,
      title: 'Grade 10 Mathematics — Mid-Term Exam',
      instructions: 'Answer all questions. Each question carries 2 marks.',
      durationMinutes: 60,
      status: ExamStatus.PUBLISHED,
      showResultsImmediately: true,
      questions: {
        create: [
          {
            text: 'What is the value of π (pi) to two decimal places?',
            type: QuestionType.MULTIPLE_CHOICE,
            points: 2,
            order: 1,
            options: {
              create: [
                { text: '3.12', isCorrect: false, order: 1 },
                { text: '3.14', isCorrect: true, order: 2 },
                { text: '3.16', isCorrect: false, order: 3 },
                { text: '3.18', isCorrect: false, order: 4 },
              ],
            },
          },
          {
            text: 'What is the square root of 144?',
            type: QuestionType.MULTIPLE_CHOICE,
            points: 2,
            order: 2,
            options: {
              create: [
                { text: '10', isCorrect: false, order: 1 },
                { text: '11', isCorrect: false, order: 2 },
                { text: '12', isCorrect: true, order: 3 },
                { text: '13', isCorrect: false, order: 4 },
              ],
            },
          },
          {
            text: 'Solve for x: 2x + 5 = 15',
            type: QuestionType.MULTIPLE_CHOICE,
            points: 2,
            order: 3,
            options: {
              create: [
                { text: '3', isCorrect: false, order: 1 },
                { text: '4', isCorrect: false, order: 2 },
                { text: '5', isCorrect: true, order: 3 },
                { text: '6', isCorrect: false, order: 4 },
              ],
            },
          },
          {
            text: 'What is the formula for the area of a circle?',
            type: QuestionType.MULTIPLE_CHOICE,
            points: 2,
            order: 4,
            options: {
              create: [
                { text: '2πr', isCorrect: false, order: 1 },
                { text: 'πr²', isCorrect: true, order: 2 },
                { text: 'πd', isCorrect: false, order: 3 },
                { text: 'r²', isCorrect: false, order: 4 },
              ],
            },
          },
          {
            text: 'If a triangle has angles 60° and 70°, what is the third angle?',
            type: QuestionType.MULTIPLE_CHOICE,
            points: 2,
            order: 5,
            options: {
              create: [
                { text: '40°', isCorrect: false, order: 1 },
                { text: '50°', isCorrect: true, order: 2 },
                { text: '60°', isCorrect: false, order: 3 },
                { text: '70°', isCorrect: false, order: 4 },
              ],
            },
          },
        ],
      },
    },
  });

  console.log('✅ Seed completed:');
  console.log(`  • Tenant: ${tenant.name} (${tenant.subdomain})`);
  console.log(`  • Admin: ${admin.email}`);
  console.log(`  • Teacher: ${teacher.email}`);
  console.log(`  • Students: ${students.map((s) => s.email).join(', ')}`);
  console.log(`  • Classes: ${class10.name}, ${class11.name}`);
  console.log(`  • Subjects: ${math.name}, ${english.name}`);
  console.log(`  • Exam: ${exam.title}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
