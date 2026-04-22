// src/school/school.routes.ts
import express from "express";
import { createSchoolHandler } from "./school.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { roleMiddleware } from "../middleware/role.middleware.js";
import { Role } from "../prisma/generated/enums.js";

const router = express.Router();

router.post(
  "/",
  authMiddleware,
  roleMiddleware([Role.SCHOOL_ADMIN]),
  createSchoolHandler,
);

export default router;
