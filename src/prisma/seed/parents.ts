export async function parentsData(prisma: any, school: any) {
  const [school1, school2] = school;
  /* Create Parents */
  console.log("Creating Parents...");
  const parent1 = await prisma.parent.upsert({
    where: { email: "charlesbadmus@gmail.com" },
    update: {},
    create: {
      firstName: "Charles",
      lastName: "Badmus",
      address: "Alocn Education center, woji",
      occupation: "Banker",
      phone: "+2348109477003",
      email: "charlesbadmus@gmail.com",
      password: "hashed_password_123",
      schoolId: school1.id,
    },
  });

  const parent2 = await prisma.parent.upsert({
    where: { email: "marybadmus@gmail.com" },
    update: {},
    create: {
      firstName: "Mary",
      lastName: "Badmus",
      address: "Woji, Port Harcourt",
      occupation: "Teacher",
      phone: "+2348109477004",
      email: "marybadmus@gmail.com",
      password: "hashed_password_123",
      schoolId: school1.id,
    },
  });

  const parent3 = await prisma.parent.upsert({
    where: { email: "emilyokoro@gmail.com" },
    update: {},
    create: {
      firstName: "Emily",
      lastName: "Okoro",
      address: "GRA, Port Harcourt",
      occupation: "Doctor",
      phone: "+2348109477005",
      email: "emilyokoro@gmail.com",
      password: "hashed_password_123",
      schoolId: school2.id,
    },
  });

  const parent4 = await prisma.parent.upsert({
    where: { email: "davidokoro@gmail.com" },
    update: {},
    create: {
      firstName: "David",
      lastName: "Okoro",
      address: "Rumuola, Port Harcourt",
      occupation: "Engineer",
      phone: "+2348109477006",
      email: "davidokoro@gmail.com",
      password: "hashed_password_123",
      schoolId: school2.id,
    },
  });

  const parent5 = await prisma.parent.upsert({
    where: { email: "gracejohnson@gmail.com" },
    update: {},
    create: {
      firstName: "Grace",
      lastName: "Johnson",
      address: "Elelenwo, Port Harcourt",
      occupation: "Nurse",
      phone: "+2348109477007",
      email: "gracejohnson@gmail.com",
      password: "hashed_password_123",
      schoolId: school1.id,
    },
  });
  return {
    parent: [parent1, parent2, parent3, parent4, parent5],
  };
}
