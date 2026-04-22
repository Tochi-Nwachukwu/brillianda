import 'dotenv/config'
import { PrismaClient, Prisma } from './prisma/generated/client.js' 
import { PrismaPg } from '@prisma/adapter-pg'
import express, { type Application } from 'express'
import type { Server } from 'http'
import authRoutes from './auth/auth.routes.js'
import schoolRoutes from './school/school.routes.js'
import cookieParser from "cookie-parser";
import { authMiddleware } from './middleware/auth.middleware.js'
import studentRoutes from './student/student.routes.js'
import cors from "cors";

  
const pool = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter: pool })

const app: Application = express()
app.use(express.json())

app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true, // 🔥 REQUIRED for cookies
  })
);


// Body parsing middlewares
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));




// Import Routes
app.use("/api/auth", authRoutes);
app.use("/api/schools", authMiddleware,schoolRoutes);
app.use("/api/students", studentRoutes);


const server: Server = app.listen(3000, () =>
  console.log(`
🚀 Server ready at: http://localhost:3000
⭐️ See sample requests: https://github.com/prisma/prisma-examples/blob/latest/orm/express/README.md#using-the-rest-api`),
)



// API Routes
/* app.use("/students", studentRoutes); */

// Basic Health Check (Optional but recommended in TS/Production)
/* app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "UP" });
});
 */
// Database connection
/* connectDB(); */






// ==========================================
// Default Blanket Utility Functions 
// ==========================================

// Handle unhandled promise rejections
/* process.on("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled Rejection:", reason);
  server.close(async () => {
    await disconnectDB();
    process.exit(1);
  });
}); */

// Handle uncaught exceptions
/* process.on("uncaughtException", async (err: Error) => {
  console.error("Uncaught Exception:", err.message);
  await disconnectDB();
  process.exit(1);
});
 */
// Graceful shutdown
/* process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(async () => {
    await disconnectDB();
    process.exit(0);
  });
}); */