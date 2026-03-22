import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function deleteStudent(req: Request, res: Response) {
    try {
        const { id } = req.params; // Student UUID
        const { schoolId } = req.body; // In production, get this from req.user.schoolId (JWT)

        if (!id || !schoolId) {
            return res.status(400).json({ error: "Student ID and School ID are required." });
        }

        // Use deleteMany to incorporate the schoolId check for security.
        // Prisma's .delete() only accepts a unique identifier (id).
        // .deleteMany() allows us to say "Delete this ID ONLY IF it belongs to this School".
        const deleteOperation = await prisma.student.deleteMany({
            where: {
                id: id,
                schoolId: schoolId
            }
        });

        if (deleteOperation.count === 0) {
            return res.status(404).json({ 
                error: "Student not found or you do not have permission to delete this record." 
            });
        }

        return res.status(200).json({ message: "Student record deleted successfully." });

    } catch (error: any) {
        // Handle cases where the student has linked records (e.g., Results or CBT scores)
        if (error.code === 'P2003') {
            return res.status(400).json({ 
                error: "Cannot delete student because they have existing academic records (Grades/CBT). Consider deactivating them instead." 
            });
        }

        console.error("Delete Error:", error);
        return res.status(500).json({ error: "Internal server error." });
    }
}