export async function studentData(prisma: any, school: any) {
  const [school1, school2] = school;
  /* Create User[ School, Admin] */
  console.log("Creating Students...");
  const student1 = await prisma.student.upsert({
  where: { email: "johnbadmus@gmail.com" },
  update: { phone: "+2348109477003" },
  create: {
    enrollmentNo: "SB001",
    firstName: "John",
    lastName: "Badmus",
    dateOfBirth: new Date("2012-01-05"),
    address: "Alocn Education center, woji",
    phone: "+2348109477003",
    email: "johnbadmus@gmail.com",
    password: "hashed_password_123",
    schoolId: school1.id,
  },
});

const student2 = await prisma.student.upsert({
  where: { email: "maryjames@gmail.com" },
  update: { phone: "+2348109477004" },
  create: {
    enrollmentNo: "SB002",
    firstName: "Mary",
    lastName: "James",
    dateOfBirth: new Date("2011-03-10"),
    address: "Woji Port Harcourt",
    phone: "+2348109477004",
    email: "maryjames@gmail.com",
    password: "hashed_password_123",
    schoolId: school1.id,
  },
});

const student3 = await prisma.student.upsert({
  where: { email: "peterokafor@gmail.com" },
  update: { phone: "+2348109477005" },
  create: {
    enrollmentNo: "SB003",
    firstName: "Peter",
    lastName: "Okafor",
    dateOfBirth: new Date("2012-07-22"),
    address: "Rumuokoro",
    phone: "+2348109477005",
    email: "peterokafor@gmail.com",
    password: "hashed_password_123",
    schoolId: school1.id,
  },
});

const student4 = await prisma.student.upsert({
  where: { email: "graceokoro@gmail.com" },
  update: { phone: "+2348109477006" },
  create: {
    enrollmentNo: "SB004",
    firstName: "Grace",
    lastName: "Okoro",
    dateOfBirth: new Date("2011-11-15"),
    address: "Elelenwo",
    phone: "+2348109477006",
    email: "graceokoro@gmail.com",
    password: "hashed_password_123",
    schoolId: school1.id,
  },
});

const student5 = await prisma.student.upsert({
  where: { email: "emekawilliams@gmail.com" },
  update: { phone: "+2348109477007" },
  create: {
    enrollmentNo: "SB005",
    firstName: "Emeka",
    lastName: "Williams",
    dateOfBirth: new Date("2010-09-01"),
    address: "GRA Port Harcourt",
    phone: "+2348109477007",
    email: "emekawilliams@gmail.com",
    password: "hashed_password_123",
    schoolId: school2.id,
  },
});

const student6 = await prisma.student.upsert({
  where: { email: "zainabalim@gmail.com" },
  update: { phone: "+2348109477008" },
  create: {
    enrollmentNo: "SB006",
    firstName: "Zainab",
    lastName: "Ali",
    dateOfBirth: new Date("2012-02-14"),
    address: "Abuloma",
    phone: "+2348109477008",
    email: "zainabalim@gmail.com",
    password: "hashed_password_123",
    schoolId: school2.id,
  },
});

const student7 = await prisma.student.upsert({
  where: { email: "davidjohn@gmail.com" },
  update: { phone: "+2348109477009" },
  create: {
    enrollmentNo: "SB007",
    firstName: "David",
    lastName: "John",
    dateOfBirth: new Date("2011-06-18"),
    address: "Trans Amadi",
    phone: "+2348109477009",
    email: "davidjohn@gmail.com",
    password: "hashed_password_123",
    schoolId: school2.id,
  },
});

const student8 = await prisma.student.upsert({
  where: { email: "esthermark@gmail.com" },
  update: { phone: "+2348109477010" },
  create: {
    enrollmentNo: "SB010",
    firstName: "Esther",
    lastName: "Mark",
    dateOfBirth: new Date("2010-12-25"),
    address: "Rumuola",
    phone: "+2348109477010",
    email: "esthermark@gmail.com",
    password: "hashed_password_123",
    schoolId: school2.id,
  },
});
  console.log("Created Kings college studets")
}
