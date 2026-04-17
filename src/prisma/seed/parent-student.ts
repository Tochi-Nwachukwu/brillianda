export async function parentStudentData(
  prisma: any,
  parent: any,
  student: any,
) {
  const [
    student1,
    student2,
    student3,
    student4,
    student5,
    student6,
    student7,
    student8,
  ] = student;
  const [parent1, parent2, parent3, parent4, parent5] = parent;
  console.log("Creating parentStudent Relationship");
  await prisma.parentStudent.createMany({
    data: [
      // 👨 Charles Badmus (Father of John + Peter)
      {
        parentId: parent1.id,
        studentId: student1.id,
        relation: "FATHER",
      },
      {
        parentId: parent1.id,
        studentId: student3.id,
        relation: "FATHER",
      },

      // 👩 Mary Badmus (Mother of John)
      {
        parentId: parent2.id,
        studentId: student1.id,
        relation: "MOTHER",
      },

      // 👩 Emily Okoro (Mother of David + Esther)
      {
        parentId: parent3.id,
        studentId: student7.id,
        relation: "MOTHER",
      },
      {
        parentId: parent3.id,
        studentId: student8.id,
        relation: "MOTHER",
      },

      // 👨 David Okoro (Father of David)
      {
        parentId: parent4.id,
        studentId: student7.id,
        relation: "FATHER",
      },

      // 👩 Grace Johnson (Guardian of Mary + Zainab)
      {
        parentId: parent5.id,
        studentId: student2.id,
        relation: "GUARDIAN",
      },
      {
        parentId: parent5.id,
        studentId: student6.id,
        relation: "GUARDIAN",
      },
    ],
    skipDuplicates: true,
  });
}
