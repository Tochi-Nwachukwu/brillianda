// src/school/school.controller.ts
import { createSchool } from "./school.service.js";

export const createSchoolHandler = async (req: any, res: any) => {
  try {
    const userId = req.user.id; // from auth middleware
    const { name, slug, address, phone } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }

    const school = await createSchool(userId, name, slug, address, phone);

    const { user, ...safeSchool } = school;

    res.status(201).json({
      ...safeSchool,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};
