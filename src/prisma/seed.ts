import "dotenv/config";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";
import { userData } from "./seed/users.js";
import { studentData } from "./seed/student.js";
import { parentsData } from "./seed/parents.js";
import { parentStudentData } from "./seed/parent-student.js";
import { teachersData } from "./seed/teachers.js";
import { classData } from "./seed/class.js";
import { formTeacherSeed } from "./seed/formTeacher.js";

const connectionString = `${process.env.DATABASE_URL}`;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Starting seed...");

  await userData(prisma);
  const { school } = await userData(prisma);

  const classes = await classData(prisma, school);
  const { student } = await studentData(prisma, school, classes);

  const { parent } = await parentsData(prisma, school);

  await classData(prisma, school);
  await studentData(prisma, school, classes);
  await parentStudentData(prisma, parent, student);
  await teachersData(prisma, school); 
  const teachers = await teachersData(prisma, school);
  await formTeacherSeed(prisma, classes, teachers); 
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Error during seed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
