import { prisma } from "../config/prisma.js";

export const createSchool = async (
  userId: string,
  name: string,
  slug: string,
  address?: string,
  phone?: string
) => {
  // 1. Check if user already has a school
  const existingSchool = await prisma.school.findUnique({
    where: { userId },
  });

  if (existingSchool) {
    throw new Error("User already has a school");
  }

  // 2. Check if slug is taken (extra safety)
  const slugExists = await prisma.school.findUnique({
    where: { slug },
  });

  if (slugExists) {
    throw new Error("Slug already in use");
  }

  // 3. Create school
  const school = await prisma.school.create({
    data: {
      userId,
      name,
      slug,
      address: address || null,
      phone: phone || null,
    },
    include: {
      user: true,
    },
  });

  return school;
};