import { Role } from "../prisma/generated/enums.js";

export const roleMiddleware = (allowedRoles: Role[]) => {
  return (req: any, res: any, next: any) => {
    const user = req.user;

    if (!user || !user.role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    next();
  };
};