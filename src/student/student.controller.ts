// src/student/student.controller.ts
import { createStudent } from "./student.service.js";

export const createStudentHandler = async (req: any, res: any) => {
  try {
    const schoolUserId = req.user.id;

    const student = await createStudent(schoolUserId, req.body);

    return res.status(201).json(student);
  } catch (err: any) {
    return res.status(400).json({ message: err.message });
  }
};