import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_brillianda_key';

export default async function loginStudent(req: Request, res: Response) {
    try {
        const { email, password } = req.body;

        // 1. Basic Validation
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required." });
        }

        // 2. Find Student and include School status
        const student = await prisma.student.findUnique({
            where: { email: email.toLowerCase() },
            include: {
                school: {
                    select: { isActive: true, name: true }
                }
            }
        });

        // 3. Check if student exists
        if (!student) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        // 4. Verify Password
        const isPasswordValid = await bcrypt.compare(password, student.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        // 5. Safety Checks (Multitenancy & Status)
        if (!student.isActive) {
            return res.status(403).json({ error: "Your account has been deactivated. Please contact your school admin." });
        }

        if (!student.school.isActive) {
            return res.status(403).json({ error: "This school's access to Brillianda is currently suspended." });
        }

        // 6. Generate JWT
        // We include schoolId so the backend can filter data automatically for this tenant
        const token = jwt.sign(
            { 
                sub: student.id, 
                schoolId: student.schoolId, 
                role: 'STUDENT' 
            },
            JWT_SECRET,
            { expiresIn: '1d' }
        );

        // 7. Successful Response
        return res.status(200).json({
            message: "Login successful",
            token,
            user: {
                id: student.id,
                firstName: student.firstName,
                lastName: student.lastName,
                schoolName: student.school.name,
                schoolId: student.schoolId
            }
        });

    } catch (error) {
        console.error("Login Error:", error);
        return res.status(500).json({ error: "Internal server error." });
    }
}