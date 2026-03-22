import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto'; // Built-in Node module
import { PrismaClient } from '@prisma/client';
import { sendEmail } from '../utils/emailService'; // Adjust path to your utility

const prisma = new PrismaClient();

export async function registerStudent(req: Request, res: Response) {
    const { firstName, lastName, email, schoolId, classId, admissionNumber, gender, dateOfBirth } = req.body;

    // 1. Validation
    if (!firstName || !lastName || !email || !schoolId || !classId || !admissionNumber) {
        return res.status(400).json({ message: "Required fields are missing" });
    }

    try {
        // 2. Generate a temporary password (e.g., BR-8a2f1b)
        const tempPassword = `BR-${crypto.randomBytes(3).toString('hex')}`;
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        // 3. Save the record in the database
        const student = await prisma.student.create({
            data: {
                firstName,
                lastName,
                email: email.toLowerCase(),
                password: hashedPassword,
                schoolId,
                classId,
                admissionNumber,
                gender,
                dateOfBirth: new Date(dateOfBirth),
                // Optional: Add a 'mustChangePassword' boolean field to your schema
                // mustChangePassword: true 
            },
            include: {
                school: { select: { name: true, slug: true } }
            }
        });

        // 4. Send the Welcome Email with Temporary Credentials
        if (student) {
            const portalUrl = `https://${student.school.slug}.brillianda.com/login`;

            await sendEmail({
                to: student.email,
                subject: `Welcome to ${student.school.name} - Brillianda Portal`,
                text: `Hello ${firstName}, your account has been created. Use the temporary password: ${tempPassword} to login.`,
                html: `
                    <div style="font-family: sans-serif; line-height: 1.6;">
                        <h2>Welcome to Brillianda, ${firstName}!</h2>
                        <p>Your student profile has been successfully created for <strong>${student.school.name}</strong>.</p>
                        <p>Below are your temporary login credentials:</p>
                        <div style="background: #f4f4f4; padding: 15px; border-radius: 5px;">
                            <p><strong>Login URL:</strong> <a href="${portalUrl}">${portalUrl}</a></p>
                            <p><strong>Username:</strong> ${student.email}</p>
                            <p><strong>Temporary Password:</strong> <span style="color: #e63946; font-weight: bold;">${tempPassword}</span></p>
                        </div>
                        <p><em>For security reasons, please change your password immediately after logging in.</em></p>
                    </div>
                `,
            });

            return res.status(201).json({ 
                message: "Student registered successfully. Credentials sent to email.",
                studentId: student.id 
            });
        }

    } catch (error: any) {
        if (error.code === 'P2002') {
            return res.status(409).json({
                message: "A student with this email or admission number already exists in this school."
            });
        }

        console.error("Error registering student:", error);
        return res.status(500).json({
            message: "An error occurred while creating the student record."
        });
    }
}
