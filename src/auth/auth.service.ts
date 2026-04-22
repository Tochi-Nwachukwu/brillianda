import { prisma } from "../config/prisma.js";
import { hashPassword, comparePassword } from "../utils/hash.js";
import { signToken } from "../utils/jwt.js";

export const registerUser = async (
  name: string,
  email: string,
  password: string,
  role: any,
) => {
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) throw new Error("User already exists");

  const hashed = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      password: hashed,
      role,
    },
  });

  return user;
};

export const loginUser = async (email: string, password: string) => {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) throw new Error("Invalid credentials");

  const valid = await comparePassword(password, user.password);

  if (!valid) throw new Error("Invalid credentials");

  const token = signToken({
    id: user.id,
    role: user.role,
    email: user.email,
  });

  return { user, token };
};
