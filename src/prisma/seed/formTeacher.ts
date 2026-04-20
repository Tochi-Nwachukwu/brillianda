export async function formTeacherSeed(
  prisma: any,
  classes: any,
  teachers: any,
) {
  console.log("Assigning Form Teachers...");
  console.log("Classes:", classes);
  console.log("Teachers:", teachers);

  const school1Classes = classes.school1Classes || classes[0];
  const school2Classes = classes.school2Classes || classes[1];

  const allTeachers = teachers.teacher; // ✅ FIX HERE

  const school1Teachers = allTeachers.filter(
    (t: any) => t.schoolId === school1Classes[0].schoolId,
  );

  const school2Teachers = allTeachers.filter(
    (t: any) => t.schoolId === school2Classes[0].schoolId,
  );

  const getClass = (list: any[], level: string) =>
    list.find((c) => c.level === level);

  const pickTeacher = (list: any[], index: number) => list[index % list.length];

  const assignments = [
    {
      class: getClass(school1Classes, "JSS1"),
      teacher: pickTeacher(school1Teachers, 0),
    },
    {
      class: getClass(school1Classes, "JSS2"),
      teacher: pickTeacher(school1Teachers, 1),
    },
    {
      class: getClass(school1Classes, "SS1"),
      teacher: pickTeacher(school1Teachers, 0),
    },

    {
      class: getClass(school2Classes, "PRIMARY_1"),
      teacher: pickTeacher(school2Teachers, 0),
    },
    {
      class: getClass(school2Classes, "PRIMARY_2"),
      teacher: pickTeacher(school2Teachers, 1),
    },
  ];

  for (const a of assignments) {
    if (!a.class || !a.teacher) continue;

    await prisma.class.update({
      where: { id: a.class.id },
      data: {
        formTeacherId: a.teacher.id,
      },
    });
  }

  console.log("Form teachers assigned successfully");
}
