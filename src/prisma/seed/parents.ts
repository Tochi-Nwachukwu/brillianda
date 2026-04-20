export async function parentsData(prisma: any, school: any) {
  const [school1, school2] = school;

  console.log("Creating Parents...");

  const parents = [
    {
      email: "charlesbadmus@gmail.com",
      firstName: "Charles",
      lastName: "Badmus",
      address: "Alcon Education Center, Woji",
      occupation: "Banker",
      phone: "+2348109477003",
      schoolId: school1.id,
    },
    {
      email: "marybadmus@gmail.com",
      firstName: "Mary",
      lastName: "Badmus",
      address: "Woji, Port Harcourt",
      occupation: "Teacher",
      phone: "+2348109477004",
      schoolId: school1.id,
    },
    {
      email: "emilyokoro@gmail.com",
      firstName: "Emily",
      lastName: "Okoro",
      address: "GRA, Port Harcourt",
      occupation: "Doctor",
      phone: "+2348109477005",
      schoolId: school2.id,
    },
    {
      email: "davidokoro@gmail.com",
      firstName: "David",
      lastName: "Okoro",
      address: "Rumuola, Port Harcourt",
      occupation: "Engineer",
      phone: "+2348109477006",
      schoolId: school2.id,
    },
    {
      email: "gracejohnson@gmail.com",
      firstName: "Grace",
      lastName: "Johnson",
      address: "Elelenwo, Port Harcourt",
      occupation: "Nurse",
      phone: "+2348109477007",
      schoolId: school1.id,
    },
  ];

  const createdParents = [];

  for (const p of parents) {
    const parent = await prisma.$transaction(async (tx: any) => {
      // 1. USER (AUTH LAYER)
      const user = await tx.user.upsert({
        where: { email: p.email },
        update: {
          name: `${p.firstName} ${p.lastName}`,
        },
        create: {
          email: p.email,
          password: "hashed_password_123",
          name: `${p.firstName} ${p.lastName}`,
          role: "PARENT",
        },
      });

      // 2. PARENT (PROFILE LAYER)
      return await tx.parent.upsert({
        where: {
          userId: user.id,
        },
        update: {
          firstName: p.firstName,
          lastName: p.lastName,
          phone: p.phone,
          address: p.address,
          occupation: p.occupation,
          schoolId: p.schoolId,
        },
        create: {
          firstName: p.firstName,
          lastName: p.lastName,
          phone: p.phone,
          address: p.address,
          occupation: p.occupation,
          schoolId: p.schoolId,
          userId: user.id,
        },
      });
    });

    createdParents.push(parent);
  }

  console.log("Parents upserted successfully");

  return {
    parent: createdParents,
  };
}