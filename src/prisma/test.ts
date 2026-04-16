// ========== CREATE USERS & TEACHERS ==========
  console.log('📚 Creating teachers...');

  const teacher1 = await prisma.user.create({
    data: {
      email: 'mr.smith@school.com',
      password: 'hashed_password_123', // In real app, use bcrypt
      name: 'Mr. John Smith',
      role: Role.TEACHER,
      teacher: {
        create: {
          employeeNo: 'T001',
          qualification: 'B.Sc Mathematics, M.Ed',
          specialization: 'Mathematics',
          phone: '+234-801-123-4567'
        }
      }
    },
    include: { teacher: true }
  });

  const teacher2 = await prisma.user.create({
    data: {
      email: 'ms.johnson@school.com',
      password: 'hashed_password_123',
      name: 'Ms. Sarah Johnson',
      role: Role.TEACHER,
      teacher: {
        create: {
          employeeNo: 'T002',
          qualification: 'B.A English, M.A Literature',
          specialization: 'English Language',
          phone: '+234-802-234-5678'
        }
      }
    },
    include: { teacher: true }
  });

  const teacher3 = await prisma.user.create({
    data: {
      email: 'dr.okafor@school.com',
      password: 'hashed_password_123',
      name: 'Dr. Emeka Okafor',
      role: Role.TEACHER,
      teacher: {
        create: {
          employeeNo: 'T003',
          qualification: 'B.Sc Physics, PhD Physics',
          specialization: 'Physics',
          phone: '+234-803-345-6789'
        }
      }
    },
    include: { teacher: true }
  });

  // ========== CREATE SUBJECTS ==========
  console.log('📖 Creating subjects...');

  const mathSubject = await prisma.subject.create({
    data: {
      name: 'Mathematics',
      code: 'MATH101',
      description: 'Foundation Mathematics for Secondary School',
      teachers: {
        connect: [{ id: teacher1.teacher!.id }]
      }
    }
  });

  const englishSubject = await prisma.subject.create({
    data: {
      name: 'English Language',
      code: 'ENG101',
      description: 'English Language and Communication Skills',
      teachers: {
        connect: [{ id: teacher2.teacher!.id }]
      }
    }
  });

  const physicsSubject = await prisma.subject.create({
    data: {
      name: 'Physics',
      code: 'PHY101',
      description: 'General Physics and Laboratory',
      teachers: {
        connect: [{ id: teacher3.teacher!.id }]
      }
    }
  });

  // ========== CREATE PARENTS ==========
  console.log('👨‍👩‍👧 Creating parents...');

  const parent1 = await prisma.user.create({
    data: {
      email: 'adeyemi.father@email.com',
      password: 'hashed_password_123',
      name: 'Mr. Adeyemi Oladele',
      role: Role.PARENT,
      parent: {
        create: {
          phone: '+234-904-111-2222',
          address: '123 Lekki Road, Lagos',
          occupation: 'Engineer'
        }
      }
    },
    include: { parent: true }
  });

  const parent2 = await prisma.user.create({
    data: {
      email: 'adeyemi.mother@email.com',
      password: 'hashed_password_123',
      name: 'Mrs. Adeyemi Folake',
      role: Role.PARENT,
      parent: {
        create: {
          phone: '+234-905-222-3333',
          address: '123 Lekki Road, Lagos',
          occupation: 'Doctor'
        }
      }
    },
    include: { parent: true }
  });

  const parent3 = await prisma.user.create({
    data: {
      email: 'chioma.father@email.com',
      password: 'hashed_password_123',
      name: 'Mr. Chioma Ifeanyi',
      role: Role.PARENT,
      parent: {
        create: {
          phone: '+234-906-333-4444',
          address: '456 Victoria Island, Lagos',
          occupation: 'Business Owner'
        }
      }
    },
    include: { parent: true }
  });

  const parent4 = await prisma.user.create({
    data: {
      email: 'blessing.guardian@email.com',
      password: 'hashed_password_123',
      name: 'Mrs. Blessing Okafor',
      role: Role.PARENT,
      parent: {
        create: {
          phone: '+234-907-444-5555',
          address: '789 Ikoyi Road, Lagos',
          occupation: 'Teacher'
        }
      }
    },
    include: { parent: true }
  });

  // ========== CREATE STUDENTS ==========
  console.log('👨‍🎓 Creating students...');

  const student1 = await prisma.user.create({
    data: {
      email: 'adeyemi.chinedu@school.com',
      password: 'hashed_password_123',
      name: 'Chinedu Adeyemi',
      role: Role.STUDENT,
      student: {
        create: {
          enrollmentNo: 'STU001',
          dateOfBirth: new Date('2008-05-15'),
          phone: '+234-901-234-5678',
          address: '123 Lekki Road, Lagos',
          subjects: {
            connect: [
              { id: mathSubject.id },
              { id: englishSubject.id },
              { id: physicsSubject.id }
            ]
          }
        }
      }
    },
    include: { student: true }
  });

  const student2 = await prisma.user.create({
    data: {
      email: 'chioma.blessing@school.com',
      password: 'hashed_password_123',
      name: 'Blessing Chioma',
      role: Role.STUDENT,
      student: {
        create: {
          enrollmentNo: 'STU002',
          dateOfBirth: new Date('2008-08-22'),
          phone: '+234-902-345-6789',
          address: '456 Victoria Island, Lagos',
          subjects: {
            connect: [
              { id: mathSubject.id },
              { id: englishSubject.id },
              { id: physicsSubject.id }
            ]
          }
        }
      }
    },
    include: { student: true }
  });

  const student3 = await prisma.user.create({
    data: {
      email: 'okafor.daniel@school.com',
      password: 'hashed_password_123',
      name: 'Daniel Okafor',
      role: Role.STUDENT,
      student: {
        create: {
          enrollmentNo: 'STU003',
          dateOfBirth: new Date('2009-01-10'),
          phone: '+234-903-456-7890',
          address: '789 Ikoyi Road, Lagos',
          subjects: {
            connect: [
              { id: mathSubject.id },
              { id: englishSubject.id }
            ]
          }
        }
      }
    },
    include: { student: true }
  });

  // ========== LINK PARENTS TO STUDENTS ==========
  console.log('👨‍👩‍👧‍👦 Linking parents to students...');

  await prisma.parentStudent.create({
    data: {
      parentId: parent1.parent!.id,
      studentId: student1.student!.id,
      relation: 'father'
    }
  });

  await prisma.parentStudent.create({
    data: {
      parentId: parent2.parent!.id,
      studentId: student1.student!.id,
      relation: 'mother'
    }
  });

  await prisma.parentStudent.create({
    data: {
      parentId: parent3.parent!.id,
      studentId: student2.student!.id,
      relation: 'father'
    }
  });

  await prisma.parentStudent.create({
    data: {
      parentId: parent4.parent!.id,
      studentId: student3.student!.id,
      relation: 'guardian'
    }
  });

  // ========== CREATE QUIZZES ==========
  console.log('✏️ Creating quizzes...');

  const mathQuiz1 = await prisma.quiz.create({
    data: {
      title: 'Algebra Basics - Chapter 1',
      description: 'Test your understanding of algebraic equations and expressions',
      subjectId: mathSubject.id,
      teacherId: teacher1.teacher!.id,
      totalQuestions: 5,
      totalMarks: 50,
      passingMarks: 25,
      duration: 30, // 30 minutes
      difficultyLevel: 'EASY',
      isPublished: true,
      scheduledDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 1 week from now
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) // 2 weeks from now
    }
  });

  const mathQuiz2 = await prisma.quiz.create({
    data: {
      title: 'Quadratic Equations - Advanced',
      description: 'Solve complex quadratic equations',
      subjectId: mathSubject.id,
      teacherId: teacher1.teacher!.id,
      totalQuestions: 5,
      totalMarks: 50,
      passingMarks: 30,
      duration: 45,
      difficultyLevel: 'HARD',
      isPublished: true,
      scheduledDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 days ago
    }
  });

  const englishQuiz = await prisma.quiz.create({
    data: {
      title: 'Shakespeare Literature Review',
      description: 'Test your knowledge of Shakespeare\'s works',
      subjectId: englishSubject.id,
      teacherId: teacher2.teacher!.id,
      totalQuestions: 5,
      totalMarks: 50,
      passingMarks: 25,
      duration: 40,
      difficultyLevel: 'MEDIUM',
      isPublished: true
    }
  });

  const physicsQuiz = await prisma.quiz.create({
    data: {
      title: 'Mechanics - Forces & Motion',
      description: 'Understanding Newton\'s Laws of Motion',
      subjectId: physicsSubject.id,
      teacherId: teacher3.teacher!.id,
      totalQuestions: 5,
      totalMarks: 50,
      passingMarks: 25,
      duration: 50,
      difficultyLevel: 'MEDIUM',
      isPublished: true
    }
  });

  // ========== CREATE QUESTIONS FOR MATH QUIZ 1 ==========
  console.log('❓ Creating questions...');

  const mathQ1 = await prisma.question.create({
    data: {
      quizId: mathQuiz1.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'Solve for x: 2x + 5 = 13',
      questionType: QuestionType.MULTIPLE_CHOICE,
      marks: 10,
      order: 1,
      options: {
        create: [
          { optionText: 'x = 2', isCorrect: false, order: 1 },
          { optionText: 'x = 4', isCorrect: true, order: 2 },
          { optionText: 'x = 6', isCorrect: false, order: 3 },
          { optionText: 'x = 8', isCorrect: false, order: 4 }
        ]
      }
    }
  });

  const mathQ2 = await prisma.question.create({
    data: {
      quizId: mathQuiz1.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'Simplify: 3x + 2x - 5x',
      questionType: QuestionType.MULTIPLE_CHOICE,
      marks: 10,
      order: 2,
      options: {
        create: [
          { optionText: '0', isCorrect: true, order: 1 },
          { optionText: 'x', isCorrect: false, order: 2 },
          { optionText: '-x', isCorrect: false, order: 3 },
          { optionText: '10x', isCorrect: false, order: 4 }
        ]
      }
    }
  });

  const mathQ3 = await prisma.question.create({
    data: {
      quizId: mathQuiz1.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'Is this statement true? x² - 4 = (x - 2)(x + 2)',
      questionType: QuestionType.TRUE_FALSE,
      marks: 10,
      order: 3,
      options: {
        create: [
          { optionText: 'True', isCorrect: true, order: 1 },
          { optionText: 'False', isCorrect: false, order: 2 }
        ]
      }
    }
  });

  const mathQ4 = await prisma.question.create({
    data: {
      quizId: mathQuiz1.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'What is the value of y when x = 3 in the equation y = 2x + 1?',
      questionType: QuestionType.MULTIPLE_CHOICE,
      marks: 10,
      order: 4,
      options: {
        create: [
          { optionText: '5', isCorrect: false, order: 1 },
          { optionText: '7', isCorrect: true, order: 2 },
          { optionText: '9', isCorrect: false, order: 3 },
          { optionText: '11', isCorrect: false, order: 4 }
        ]
      }
    }
  });

  const mathQ5 = await prisma.question.create({
    data: {
      quizId: mathQuiz1.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'Expand: (a + 2)(a + 3)',
      questionType: QuestionType.SHORT_ANSWER,
      marks: 10,
      order: 5
    }
  });

  // ========== CREATE QUESTIONS FOR MATH QUIZ 2 ==========
  const mathQ6 = await prisma.question.create({
    data: {
      quizId: mathQuiz2.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'Solve: x² - 5x + 6 = 0',
      questionType: QuestionType.MULTIPLE_CHOICE,
      marks: 10,
      order: 1,
      options: {
        create: [
          { optionText: 'x = 1 or x = 6', isCorrect: false, order: 1 },
          { optionText: 'x = 2 or x = 3', isCorrect: true, order: 2 },
          { optionText: 'x = 3 or x = 4', isCorrect: false, order: 3 },
          { optionText: 'x = 4 or x = 5', isCorrect: false, order: 4 }
        ]
      }
    }
  });

  const mathQ7 = await prisma.question.create({
    data: {
      quizId: mathQuiz2.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'Find the discriminant of x² + 2x + 5 = 0',
      questionType: QuestionType.MULTIPLE_CHOICE,
      marks: 10,
      order: 2,
      options: {
        create: [
          { optionText: '-16', isCorrect: true, order: 1 },
          { optionText: '16', isCorrect: false, order: 2 },
          { optionText: '-4', isCorrect: false, order: 3 },
          { optionText: '4', isCorrect: false, order: 4 }
        ]
      }
    }
  });

  const mathQ8 = await prisma.question.create({
    data: {
      quizId: mathQuiz2.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'The sum of roots of x² - 7x + 12 = 0 is 7',
      questionType: QuestionType.TRUE_FALSE,
      marks: 10,
      order: 3,
      options: {
        create: [
          { optionText: 'True', isCorrect: true, order: 1 },
          { optionText: 'False', isCorrect: false, order: 2 }
        ]
      }
    }
  });

  const mathQ9 = await prisma.question.create({
    data: {
      quizId: mathQuiz2.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'Using the quadratic formula, solve: 2x² - 3x - 2 = 0',
      questionType: QuestionType.SHORT_ANSWER,
      marks: 10,
      order: 4
    }
  });

  const mathQ10 = await prisma.question.create({
    data: {
      quizId: mathQuiz2.id,
      teacherId: teacher1.teacher!.id,
      questionText: 'What are the roots of (x - 3)² = 0?',
      questionType: QuestionType.MULTIPLE_CHOICE,
      marks: 10,
      order: 5,
      options: {
        create: [
          { optionText: 'x = 0 (double root)', isCorrect: false, order: 1 },
          { optionText: 'x = 3 (double root)', isCorrect: true, order: 2 },
          { optionText: 'x = -3 (double root)', isCorrect: false, order: 3 },
          { optionText: 'x = 1, x = 3', isCorrect: false, order: 4 }
        ]
      }
    }
  });

  // ========== CREATE QUIZ ATTEMPTS (Student submissions) ==========
  console.log('📝 Creating quiz attempts...');

  // Student 1 attempting Math Quiz 2 (completed)
  const attempt1 = await prisma.quizAttempt.create({
    data: {
      quizId: mathQuiz2.id,
      studentId: student1.student!.id,
      startTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
      endTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 + 40 * 60 * 1000), // 40 mins later
      status: AttemptStatus.COMPLETED,
      obtainedMarks: 40,
      percentage: 80
    }
  });

  // Student 2 attempting Math Quiz 2 (completed)
  const attempt2 = await prisma.quizAttempt.create({
    data: {
      quizId: mathQuiz2.id,
      studentId: student2.student!.id,
      startTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      endTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 + 45 * 60 * 1000),
      status: AttemptStatus.COMPLETED,
      obtainedMarks: 35,
      percentage: 70
    }
  });

  // Student 1 attempting English Quiz (in progress)
  const attempt3 = await prisma.quizAttempt.create({
    data: {
      quizId: englishQuiz.id,
      studentId: student1.student!.id,
      startTime: new Date(Date.now() - 10 * 60 * 1000), // 10 mins ago
      status: AttemptStatus.IN_PROGRESS
    }
  });

  // ========== RECORD STUDENT ANSWERS ==========
  console.log('✅ Recording student answers...');

  // Student 1's answers for Math Quiz 2
  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt1.id,
      questionId: mathQ6.id,
      selectedOptionId: (await prisma.questionOption.findFirst({
        where: { questionId: mathQ6.id, isCorrect: true }
      }))!.id,
      isCorrect: true,
      marksObtained: 10
    }
  });

  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt1.id,
      questionId: mathQ7.id,
      selectedOptionId: (await prisma.questionOption.findFirst({
        where: { questionId: mathQ7.id, isCorrect: true }
      }))!.id,
      isCorrect: true,
      marksObtained: 10
    }
  });

  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt1.id,
      questionId: mathQ8.id,
      selectedOptionId: (await prisma.questionOption.findFirst({
        where: { questionId: mathQ8.id, isCorrect: true }
      }))!.id,
      isCorrect: true,
      marksObtained: 10
    }
  });

  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt1.id,
      questionId: mathQ9.id,
      userAnswer: 'x = 2 or x = -1/2',
      isCorrect: true,
      marksObtained: 10
    }
  });

  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt1.id,
      questionId: mathQ10.id,
      selectedOptionId: (await prisma.questionOption.findFirst({
        where: { questionId: mathQ10.id, isCorrect: true }
      }))!.id,
      isCorrect: true,
      marksObtained: 10
    }
  });

  // Student 2's answers for Math Quiz 2 (some wrong)
  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt2.id,
      questionId: mathQ6.id,
      selectedOptionId: (await prisma.questionOption.findFirst({
        where: { questionId: mathQ6.id, isCorrect: true }
      }))!.id,
      isCorrect: true,
      marksObtained: 10
    }
  });

  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt2.id,
      questionId: mathQ7.id,
      selectedOptionId: (await prisma.questionOption.findFirst({
        where: { questionId: mathQ7.id, order: 2 }
      }))!.id,
      isCorrect: false,
      marksObtained: 0
    }
  });

  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt2.id,
      questionId: mathQ8.id,
      selectedOptionId: (await prisma.questionOption.findFirst({
        where: { questionId: mathQ8.id, isCorrect: true }
      }))!.id,
      isCorrect: true,
      marksObtained: 10
    }
  });

  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt2.id,
      questionId: mathQ9.id,
      userAnswer: 'x = 2',
      isCorrect: false,
      marksObtained: 0
    }
  });

  await prisma.studentAnswer.create({
    data: {
      attemptId: attempt2.id,
      questionId: mathQ10.id,
      selectedOptionId: (await prisma.questionOption.findFirst({
        where: { questionId: mathQ10.id, isCorrect: true }
      }))!.id,
      isCorrect: true,
      marksObtained: 10
    }
  });

  console.log('✨ Seed completed successfully!');
  console.log('\n📊 Summary:');
  console.log('   Teachers: 3');
  console.log('   Students: 3');
  console.log('   Parents: 4');
  console.log('   Subjects: 3');
  console.log('   Quizzes: 4');
  console.log('   Questions: 15');
  console.log('   Quiz Attempts: 3 (2 completed, 1 in progress)');
  console.log('\n🔐 Login Credentials:');
  console.log('   Teacher: mr.smith@school.com / hashed_password_123');
  console.log('   Student: adeyemi.chinedu@school.com / hashed_password_123');
  console.log('   Parent: adeyemi.father@email.com / hashed_password_123');