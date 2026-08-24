import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { registerSchema, type RegisterInput } from "@/lib/auth-schema";

export default function RegisterPage() {
  const navigate = useNavigate();
  const { register: registerAccount } = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    defaultValues: { email: "", password: "", name: "", role: "customer" },
  });

  const onSubmit = handleSubmit(async (values) => {
    const parsed = registerSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "email" || field === "password" || field === "name" || field === "role") {
          setError(field, { message: issue.message });
        }
      }
      return;
    }

    setServerError(null);
    try {
      const signedIn = await registerAccount(parsed.data);
      navigate(signedIn.role === "merchant_admin" ? "/products" : "/policy", { replace: true });
    } catch (error) {
      setServerError(error instanceof Error ? error.message : "Registration failed");
    }
  });

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-background px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(217_18%_16%/0.35)_1px,transparent_1px),linear-gradient(to_bottom,hsl(217_18%_16%/0.35)_1px,transparent_1px)] bg-[size:48px_48px]"
      />
      <form
        onSubmit={onSubmit}
        className="relative z-10 w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-8"
      >
        <div className="space-y-2">
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Onboarding</p>
          <h1 className="text-3xl font-semibold tracking-tight">Create account</h1>
          <p className="text-sm text-muted-foreground">Customer or merchant admin</p>
        </div>

        <label className="block space-y-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
            Name
          </span>
          <input
            type="text"
            autoComplete="name"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-ring focus-visible:ring-2"
            {...register("name")}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </label>

        <label className="block space-y-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
            Email
          </span>
          <input
            type="email"
            autoComplete="email"
            className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-ring focus-visible:ring-2"
            {...register("email")}
          />
          {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
        </label>

        <label className="block space-y-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
            Password
          </span>
          <input
            type="password"
            autoComplete="new-password"
            className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-ring focus-visible:ring-2"
            {...register("password")}
          />
          {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
        </label>

        <label className="block space-y-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
            Role
          </span>
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-ring focus-visible:ring-2"
            {...register("role")}
          >
            <option value="customer">Customer</option>
            <option value="merchant_admin">Merchant admin</option>
          </select>
          {errors.role && <p className="text-sm text-destructive">{errors.role.message}</p>}
        </label>

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create account"}
        </Button>

        <p className="text-sm text-muted-foreground">
          Already registered?{" "}
          <Link to="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
