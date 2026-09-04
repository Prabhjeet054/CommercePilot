import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

export function CustomerShell({ title, children }: { title: string; children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <main className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-8 py-5">
        <div className="flex items-center gap-6">
          <Link to="/" className="font-mono text-xs tracking-[0.28em] text-muted-foreground">
            CP-CONSOLE
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        </div>
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="sm">
            <Link to="/shop">Shop</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/policy">Policy</Link>
          </Button>
          <span className="font-mono text-xs text-muted-foreground">{user?.email}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>
      {children}
    </main>
  );
}
