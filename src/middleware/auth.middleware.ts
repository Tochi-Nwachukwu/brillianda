import { verifyToken } from "../utils/jwt.js";

export const authMiddleware = (req: any, res: any, next: any) => {
  try {
    const token = req.cookies?.jwt;

    if (!token) {
      return res.status(401).json({ message: "No token" });
    }

    const decoded = verifyToken(token);

    req.user = decoded;

    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};