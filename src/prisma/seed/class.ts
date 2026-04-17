export async function classData(prisma: any, school: any[]) {
  const [school1, school2] = school;

  console.log("Creating Classes...");

  await prisma.class.createMany({
    data: [
      // 🏫 School 1 (Sure Bloom)

      // Primary
      { level: "PRIMARY_1", arm: "A", schoolId: school1.id },
      { level: "PRIMARY_2", arm: "A", schoolId: school1.id },
      { level: "PRIMARY_3", arm: "A", schoolId: school1.id },
      { level: "PRIMARY_4", arm: "A", schoolId: school1.id },
      { level: "PRIMARY_5", arm: "A", schoolId: school1.id },

      // Junior Secondary
      { level: "JSS1", arm: "A", schoolId: school1.id },
      { level: "JSS1", arm: "B", schoolId: school1.id },
      { level: "JSS2", arm: "A", schoolId: school1.id },
      { level: "JSS3", arm: "A", schoolId: school1.id },

      // Senior Secondary
      { level: "SS1", arm: "A", schoolId: school1.id },
      { level: "SS2", arm: "A", schoolId: school1.id },
      { level: "SS3", arm: "A", schoolId: school1.id },

      // 🏫 School 2 (Kings College)

      // Primary
      { level: "PRIMARY_1", arm: "A", schoolId: school2.id },
      { level: "PRIMARY_2", arm: "A", schoolId: school2.id },
      { level: "PRIMARY_3", arm: "A", schoolId: school2.id },
      { level: "PRIMARY_4", arm: "A", schoolId: school2.id },
      { level: "PRIMARY_5", arm: "A", schoolId: school2.id },

      // Junior Secondary
      { level: "JSS1", arm: "A", schoolId: school2.id },
      { level: "JSS2", arm: "A", schoolId: school2.id },
      { level: "JSS3", arm: "A", schoolId: school2.id },

      // Senior Secondary
      { level: "SS1", arm: "A", schoolId: school2.id },
      { level: "SS2", arm: "A", schoolId: school2.id },
      { level: "SS3", arm: "A", schoolId: school2.id },
    ],
    skipDuplicates: true,
  });
  const [school1Classes, school2Classes] = await Promise.all([
    prisma.class.findMany({ where: { schoolId: school1.id } }),
    prisma.class.findMany({ where: { schoolId: school2.id } }),
  ]);

  console.log("Classes created...");
  console.log(school1Classes, school2Classes);

  return {
    school1Classes,
    school2Classes,
  };
}
