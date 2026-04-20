export async function teachersData(prisma: any, school: any) {
  const [school1, school2] = school;

  console.log("Creating Teachers...");

  const createTeacher = async (data: any, schoolId: string) => {
    return prisma.$transaction(async (tx: any) => {
      // 1. USER (auth layer)
      const user = await tx.user.upsert({
        where: { email: data.email },
        update: {
          name: `${data.firstName} ${data.lastName}`,
        },
        create: {
          email: data.email,
          password: "hashed_password_123",
          name: `${data.firstName} ${data.lastName}`,
          role: "TEACHER",
        },
      });

      // 2. TEACHER (profile layer)
      return tx.teacher.upsert({
        where: { employeeNo: data.employeeNo },
        update: {
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          address: data.address,
          qualification: data.qualification,
          schoolId,
          userId: user.id,
        },
        create: {
          employeeNo: data.employeeNo,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          address: data.address,
          qualification: data.qualification,
          schoolId,
          userId: user.id,
        },
      });
    });
  };

  const teacher1 = await createTeacher(
    {
      employeeNo: "TCH001",
      firstName: "Michael",
      lastName: "Johnson",
      email: "michaeljohnson@gmail.com",
      address: "Woji, Port Harcourt",
      qualification: "BSc Education",
      phone: "+2348109000001",
    },
    school1.id
  );

  const teacher2 = await createTeacher(
    {
      employeeNo: "TCH002",
      firstName: "Grace",
      lastName: "Adams",
      email: "graceadams@gmail.com",
      address: "GRA, Port Harcourt",
      qualification: "MSc Mathematics",
      phone: "+2348109000002",
    },
    school1.id
  );

  const teacher3 = await createTeacher(
    {
      employeeNo: "TCH003",
      firstName: "Daniel",
      lastName: "Okoro",
      email: "danielokoro@gmail.com",
      address: "Rumuola, Port Harcourt",
      qualification: "BEd Physics",
      phone: "+2348109000003",
    },
    school2.id
  );

  const teacher4 = await createTeacher(
    {
      employeeNo: "TCH004",
      firstName: "Esther",
      lastName: "Brown",
      email: "estherbrown@gmail.com",
      address: "Elelenwo, Port Harcourt",
      qualification: "BSc Chemistry",
      phone: "+2348109000004",
    },
    school2.id
  );

  console.log("Teachers created");

  return {
    teacher: [teacher1, teacher2, teacher3, teacher4],
  };
}