import jwt from "jsonwebtoken";
import { type Response as ExpressResponse } from "express";

export const generateToken = (userId: string, res: ExpressResponse) => {
    const payload = { id: userId };
    const token = jwt.sign(payload, process.env.JWT_SECRET as string, {
        expiresIn: (process.env.JWT_EXPIRES_IN || "7d") as any,
    });

    res.cookie("jwt", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 1000 * 60 * 60 * 24 * 7,
    });
    return token;
};