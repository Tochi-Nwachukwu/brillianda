import express, { type Application, type Request, type Response } from "express";
import { Server } from "http";
import { config } from "dotenv";
import { connectDB, disconnectDB } from "./config/db.js";
import customerRoutes from "./4_customer/routes/customerRoutes.js";
import adminRoutes from "./1_admin/routes/adminRoutes.js";
import restaurantRoutes from "./2_restaurant/routes/restaurantRoutes.js";

// Import Routes


// Initialize environment variables
config();

const app: Application = express();
const PORT: number = parseInt(process.env.PORT || "5001", 10);

// Body parsing middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use("/customer", customerRoutes);
app.use("/admin", adminRoutes);
app.use("/restaurant", restaurantRoutes);

// Basic Health Check (Optional but recommended in TS/Production)
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "UP" });
});

// Database connection
connectDB();


const server: Server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on PORT ${PORT}`);
});



// ==========================================
// Default Blanket Utility Functions 
// ==========================================

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled Rejection:", reason);
  server.close(async () => {
    await disconnectDB();
    process.exit(1);
  });
});

// Handle uncaught exceptions
process.on("uncaughtException", async (err: Error) => {
  console.error("Uncaught Exception:", err.message);
  await disconnectDB();
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(async () => {
    await disconnectDB();
    process.exit(0);
  });
});