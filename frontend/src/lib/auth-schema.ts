import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email("Invalid email").max(255),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  name: z.string().min(1, "Name is required").max(120),
  role: z.enum(["customer", "merchant_admin"], {
    errorMap: () => ({ message: "Role must be customer or merchant_admin" }),
  }),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email").max(255),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
