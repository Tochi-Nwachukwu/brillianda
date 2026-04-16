export async function studentData(prisma: any, school: any) {
  const [school1, school2] = school;
  /* Create User[ School, Admin] */
  console.log("Creating Students...");
  const student1 = await prisma.student.upsert({
    where: {
      email: "johnbadmus@gmail.com",
    },
    update: { phone: "+2348109477003", },
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
    where: {
      email: "emmaobinna@gmail.com",
    },
    update: {},
    create: {
      enrollmentNo: "SB008",
      firstName: "Emmanuel",
      lastName: "Obinna",
      dateOfBirth: new Date("2009-07-08"),
      address: "Peter Odili Road, Ph",
      phone: "+2348109477003",
      email: "emmaobinna@gmail.com",
      password: "hashed_password_123",
      schoolId: school1.id,
    },
  });
  console.log("Surebloom Student Created... Creating Kings College")
  const student3 = await prisma.student.upsert({
    where: {
      email: "chrisokoro@gmail.com",
    },
    update: {},
    create: {
      enrollmentNo: "KC252601",
      firstName: "Christiana",
      lastName: "Okoro",
      dateOfBirth: new Date("2012-11-25"),
      address: "First Attilery",
      phone: "+23409123304184",
      email: "chrisokoro@gmail.com",
      password: "hashed_password_123",
      schoolId: school2.id,
    },
  });
  const student4 = await prisma.student.upsert({
    where: {
      email: "davidgreat@gmail.com",
    },
    update: {},
    create: {
      enrollmentNo: "KC252609",
      firstName: "David",
      lastName: "Great",
      dateOfBirth: new Date("2010-07-22"),
      address: "Rumokoro Park, Ph",
      phone: "+234812346785",
      email: "davidgreat@gmail.com",
      password: "hashed_password_123",
      schoolId: school2.id,
    },
  });
  console.log("Created Kings college studets")
}
