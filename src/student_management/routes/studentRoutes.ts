import express from "express";
import { registerStudent } from "../controllers/registerStudent.js";

const router = express.Router();

const authBase: string = "/auth"


// Resturant application endpoints
router.post('/registerStudent', registerStudent)



export default router;