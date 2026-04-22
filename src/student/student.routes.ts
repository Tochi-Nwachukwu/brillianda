// src/student/student.routes.ts
import express from "express";
import { createStudentHandler } from "./student.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { roleMiddleware } from "../middleware/role.middleware.js";
import { Role } from "../prisma/generated/enums.js";

const router = express.Router();

router.post(
  "/",
  authMiddleware,
  roleMiddleware([Role.SCHOOL_ADMIN]),
  createStudentHandler
);

export default router;