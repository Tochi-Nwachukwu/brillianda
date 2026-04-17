export async function teachersData(prisma: any, school: any) {
  const [school1, school2] = school;
  console.log("Creating Teachers For School 1");
  const teacher1 = await prisma.teacher.upsert({
    where: { email: "michaeljohnson@gmail.com" },
    update: {},
    create: {
      employeeNo: "TCH001",
      firstName: "Michael",
      lastName: "Johnson",
      email: "michaeljohnson@gmail.com",
      password: "hashed_password_123",
      address: "Woji, Port Harcourt",
      qualification: "BSc Education",
      phone: "+2348109000001",
      schoolId: school1.id,
    },
  });

  const teacher2 = await prisma.teacher.upsert({
    where: { email: "graceadams@gmail.com" },
    update: {},
    create: {
      employeeNo: "TCH002",
      firstName: "Grace",
      lastName: "Adams",
      email: "graceadams@gmail.com",
      password: "hashed_password_123",
      address: "GRA, Port Harcourt",
      qualification: "MSc Mathematics",
      phone: "+2348109000002",
      schoolId: school1.id,
    },
  });
  console.log("Created For One.... Creating for two");
  const teacher3 = await prisma.teacher.upsert({
    where: { email: "danielokoro@gmail.com" },
    update: {},
    create: {
      employeeNo: "TCH003",
      firstName: "Daniel",
      lastName: "Okoro",
      email: "danielokoro@gmail.com",
      password: "hashed_password_123",
      address: "Rumuola, Port Harcourt",
      qualification: "BEd Physics",
      phone: "+2348109000003",
      schoolId: school2.id,
    },
  });

  const teacher4 = await prisma.teacher.upsert({
    where: { email: "estherbrown@gmail.com" },
    update: {},
    create: {
      employeeNo: "TCH004",
      firstName: "Esther",
      lastName: "Brown",
      email: "estherbrown@gmail.com",
      password: "hashed_password_123",
      address: "Elelenwo, Port Harcourt",
      qualification: "BSc Chemistry",
      phone: "+2348109000004",
      schoolId: school2.id,
    },
  });
}
