export async function parentStudentData(
  prisma: any,
  parents: any,
  students: any,
) {
  console.log("Creating ParentStudent relationships...");

  const parentMap = Object.fromEntries(
    parents.map((p: any) => [p.firstName + p.lastName, p]), // safe fallback key
  );

  const studentMap = Object.fromEntries(
    students.map((s: any) => [s.enrollmentNo, s]),
  );

  const getP = (key: string) => {
    const p = parentMap[key];
    if (!p) throw new Error(`Parent not found: ${key}`);
    return p;
  };

  const getS = (enrollmentNo: string) => {
    const s = studentMap[enrollmentNo];
    if (!s) throw new Error(`Student not found: ${enrollmentNo}`);
    return s;
  };

  await prisma.parentStudent.createMany({
    data: [
      // Charles Badmus → John, Peter
      {
        parentId: getP("CharlesBadmus").id,
        studentId: getS("SB001").id,
        relation: "FATHER",
      },
      {
        parentId: getP("CharlesBadmus").id,
        studentId: getS("SB003").id,
        relation: "FATHER",
      },

      // Mary Badmus → John
      {
        parentId: getP("MaryBadmus").id,
        studentId: getS("SB001").id,
        relation: "MOTHER",
      },

      // Emily Okoro → David, Esther
      {
        parentId: getP("EmilyOkoro").id,
        studentId: getS("SB007").id,
        relation: "MOTHER",
      },
      {
        parentId: getP("EmilyOkoro").id,
        studentId: getS("SB010").id,
        relation: "MOTHER",
      },

      // David Okoro → David
      {
        parentId: getP("DavidOkoro").id,
        studentId: getS("SB007").id,
        relation: "FATHER",
      },

      // Grace Johnson → Mary, Zainab
      {
        parentId: getP("GraceJohnson").id,
        studentId: getS("SB002").id,
        relation: "GUARDIAN",
      },
      {
        parentId: getP("GraceJohnson").id,
        studentId: getS("SB006").id,
        relation: "GUARDIAN",
      },
    ],
    skipDuplicates: true,
  });

  console.log("ParentStudent relationships created successfully");
}
