import { Role } from "../generated/enums.js";

export async function userData(prisma: any) {
  /* Create User[ School, Admin] */
  console.log("Creating Users...");
  const school1 = await prisma.user.upsert({
    where: {
      email: "surebloomint@gmail.com", // ONLY unique field here
    },
    update: {}, // what to update if exists
    create: {
      email: "surebloomint@gmail.com",
      password: "hashed_password_123",
      name: "Sure Bloom Int School",
      role: Role.SCHOOL,
      school: {
        create: {
          address: "White House Alcon Road",
          name: "Sure Bloom Int School",
          slug: "sure-bloom-school",
          phone: "+234-801-123-4567",
        },
      },
    },
    include: { school: true },
  });

  const school2 = await prisma.user.upsert({
    where: { email: "kingscollege@gmailcom" },
    update: {},
    create: {
      email: "kingscollege@gmailcom",
      password: "hashed_password_123",
      name: "Kings College Lagos",
      role: Role.SCHOOL,
      school: {
        create: {
          address: "Obalende Road, Lagos",
          name: "Kings College Lagos",
          slug: "kings-college-lagos",
          phone: "+234-801-123-4567",
        },
      },
    },
    include: { school: true },
  });
  console.log("Created Schools...");

  const admin1 = await prisma.user.upsert({
    where: { email: "jasperezepue@gmail.com" },
    update: {},
    create: {
      email: "jasperezepue@gmail.com",
      password: "hashed_password_123",
      name: "Ezepue James",
      role: Role.ADMIN,
      admin: {
        create: {
          phone: "+234-801-123-4567",
        },
      },
    },
    include: { school: true },
  });

  const admin2 = await prisma.user.upsert({
    where: { email: "jasperbusiness@gmail.com" },
    update: {},
    create: {
      email: "jasperbusiness@gmail.com",
      password: "hashed_password_123",
      name: "Ezepue Emeka",
      role: Role.ADMIN,
      admin: {
        create: {
          phone: "+234-801-123-4567",
        },
      },
    },
    include: { school: true },
  });
  console.log("Created Admins...", admin2.email, school1.name);
  const admin3 = await prisma.user.upsert({
    where: { email: "jasperbusiness245@gmail.com" },
    update: {},
    create: {
      email: "jasperbusiness245@gmail.com",
      password: "hashed_password_123",
      name: "Ezepue Emeka",
      role: Role.ADMIN,
      admin: {
        create: {
          phone: "+234-801-123-4567",
        },
      },
    },
    include: { school: true },
  });
  const admin4 = await prisma.user.upsert({
    where: { email: "jasperbusiness2145@gmail.com" },
    update: {},
    create: {
      email: "jasperbusiness2145@gmail.com",
      password: "hashed_password_123",
      name: "Ezepue Emeka",
      role: Role.ADMIN,
      admin: {
        create: {
          phone: "+234-801-123-4567",
        },
      },
    },
    include: { school: true },
  });

  return {
    school: [school1.school, school2.school],
  };
}
