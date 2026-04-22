import { registerUser, loginUser } from "./auth.service.js";

export const register = async (req: any, res: any) => {
  try {
    const { name, email, password, role } = req.body;

    const user = await registerUser(name, email, password, role);

    const { password: _, ...safeUser } = user;

    return res.status(201).json(safeUser);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

export const login = async (req: any, res: any) => {
  try {
    const { email, password } = req.body;

    const result = await loginUser(email, password);

    // 🔥 COOKIE GOES HERE
    res.cookie("jwt", result.token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      user: result.user,
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};
