import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function registerSchool(req: Request, res: Response) {
    try {
        const { 
            schoolName, 
            adminEmail, 
            adminPassword, 
            address, 
            phoneNumber 
        } = req.body;

        // 1. Validation
        if (!schoolName || !adminEmail || !adminPassword) {
            return res.status(400).json({ error: "Missing essential registration details." });
        }

        // 2. Generate a URL-friendly slug (e.g., "Holy Child Secondary" -> "holy-child-secondary")
        const slug = schoolName
            .toLowerCase()
            .replace(/ /g, '-')
            .replace(/[^\w-]+/g, '');

        // 3. Hash the admin's password
        const hashedPassword = await bcrypt.hash(adminPassword, 10);

        // 4. Atomic Transaction: Create School AND Admin
        const result = await prisma.$transaction(async (tx) => {
            // Create the School
            const newSchool = await tx.school.create({
                data: {
                    name: schoolName,
                    slug: slug,
                    email: adminEmail,
                    address: address || "Address not provided",
                    phoneNumber: phoneNumber,
                }
            });

            // Create the first Admin Staff member for this school
            const adminUser = await tx.staff.create({
                data: {
                    email: adminEmail.toLowerCase(),
                    password: hashedPassword,
                    firstName: "School",
                    lastName: "Admin",
                    role: "ADMIN", // Assuming you have a StaffRole enum
                    schoolId: newSchool.id
                }
            });

            return { school: newSchool, admin: adminUser };
        });

        // 5. Response
        return res.status(201).json({
            message: "Brillianda setup complete!",
            schoolUrl: `https://${result.school.slug}.brillianda.com`,
            schoolId: result.school.id
        });

    } catch (error: any) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: "A school with this name or email already exists." });
        }
        console.error("School Registration Error:", error);
        return res.status(500).json({ error: "Failed to provision school." });
    }
}