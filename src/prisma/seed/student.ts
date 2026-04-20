export async function studentData(prisma: any, school: any, classes: any) {
  const [school1, school2] = school;
  const { school1Classes, school2Classes } = classes;

  const getClassId = (classes: any[], level: string, arm = "A") => {
    const found = classes.find((c) => c.level === level && c.arm === arm);
    if (!found) throw new Error(`Class ${level} ${arm} not found`);
    return found.id;
  };

  console.log("Upserting Students...");

const students = [
  {
    enrollmentNo: "SB001",
    firstName: "John",
    lastName: "Badmus",
    email: "johnbadmus@gmail.com",
    phone: "+2348109477003",
    address: "Woji, Port Harcourt",
    school: school1,
    classId: getClassId(school1Classes, "JSS1"),
  },
  {
    enrollmentNo: "SB002",
    firstName: "Mary",
    lastName: "James",
    email: "maryjames@gmail.com",
    phone: "+2348109477004",
    address: "Rumuokoro, Port Harcourt",
    school: school1,
    classId: getClassId(school1Classes, "SS1"),
  },
  {
    enrollmentNo: "SB003",
    firstName: "Peter",
    lastName: "Okafor",
    email: "peterokafor@gmail.com",
    phone: "+2348109477005",
    address: "Aluu, Port Harcourt",
    school: school1,
    classId: getClassId(school1Classes, "JSS1"),
  },
  {
    enrollmentNo: "SB004",
    firstName: "Grace",
    lastName: "Okoro",
    email: "graceokoro@gmail.com",
    phone: "+2348109477006",
    address: "Elelenwo, Port Harcourt",
    school: school1,
    classId: getClassId(school1Classes, "SS1"),
  },
  {
    enrollmentNo: "SB005",
    firstName: "Emeka",
    lastName: "Williams",
    email: "emekawilliams@gmail.com",
    phone: "+2348109477007",
    address: "GRA, Port Harcourt",
    school: school2,
    classId: getClassId(school2Classes, "SS1"),
  },
  {
    enrollmentNo: "SB006",
    firstName: "Zainab",
    lastName: "Ali",
    email: "zainabalim@gmail.com",
    phone: "+2348109477008",
    address: "Abuloma, Port Harcourt",
    school: school2,
    classId: getClassId(school2Classes, "PRIMARY_1"),
  },
  {
    enrollmentNo: "SB007",
    firstName: "David",
    lastName: "John",
    email: "davidjohn@gmail.com",
    phone: "+2348109477009",
    address: "Trans Amadi, Port Harcourt",
    school: school2,
    classId: getClassId(school2Classes, "SS1"),
  },
  {
    enrollmentNo: "SB010",
    firstName: "Esther",
    lastName: "Mark",
    email: "esthermark@gmail.com",
    phone: "+2348109477010",
    address: "Rumuola, Port Harcourt",
    school: school2,
    classId: getClassId(school2Classes, "JSS1"),
  },
];

  const createdStudents = [];

  for (const s of students) {
    const student = await prisma.$transaction(async (tx: any) => {
      // 1. USER (AUTH LAYER)
      const user = await tx.user.upsert({
        where: { email: s.email },
        update: {
          name: `${s.firstName} ${s.lastName}`,
        },
        create: {
          email: s.email,
          password: "hashed_password_123",
          name: `${s.firstName} ${s.lastName}`,
          role: "STUDENT",
        },
      });

      // 2. STUDENT (PROFILE LAYER)
      return await tx.student.upsert({
        where: {
          enrollmentNo_schoolId: {
            enrollmentNo: s.enrollmentNo,
            schoolId: s.school.id,
          },
        },
        update: {
          firstName: s.firstName,
          lastName: s.lastName,
          phone: s.phone,
          classId: s.classId,
          userId: user.id,
          address: s.address,
        },
        create: {
          enrollmentNo: s.enrollmentNo,
          firstName: s.firstName,
          lastName: s.lastName,
          dateOfBirth: new Date("2012-01-01"),
          phone: s.phone,
          address: s.address,
          schoolId: s.school.id,
          classId: s.classId,
          userId: user.id,
        },
      });
    });

    createdStudents.push(student);
  }

  console.log("Students upserted successfully");

  return { student: createdStudents };
}
