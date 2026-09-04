import { Link, Route, Routes } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth-context";
import AICommerceDashboard from "@/pages/AICommerceDashboard";
import AIShoppingChat from "@/pages/AIShoppingChat";
import LoginPage from "@/pages/Login";
import PolicySettingsPage from "@/pages/PolicySettings";
import ProductComparisonPage from "@/pages/ProductComparison";
import ProductManagementPage from "@/pages/ProductManagement";
import PurchaseReviewPage from "@/pages/PurchaseReview";
import RegisterPage from "@/pages/Register";

function LandingPage() {
  const { user, isReady, logout } = useAuth();

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(217_18%_16%/0.35)_1px,transparent_1px),linear-gradient(to_bottom,hsl(217_18%_16%/0.35)_1px,transparent_1px)] bg-[size:48px_48px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
      />

      <header className="relative z-10 flex items-center justify-between px-8 py-6">
        <span className="font-mono text-xs tracking-[0.28em] text-muted-foreground">
          CP-CONSOLE
        </span>
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs text-muted-foreground">INR · TEST MODE</span>
          {isReady && user ? (
            <>
              {user.role === "merchant_admin" && (
                <Button asChild variant="outline" size="sm">
                  <Link to="/products">Catalog</Link>
                </Button>
              )}
              {user.role === "customer" && (
                <>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/shop">Shop</Link>
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/policy">Policy</Link>
                  </Button>
                </>
              )}
              <span className="font-mono text-xs text-foreground">{user.email}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
                Sign out
              </Button>
            </>
          ) : (
            <div className="flex gap-3">
              <Button asChild variant="outline" size="sm">
                <Link to="/login">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/register">Register</Link>
              </Button>
            </div>
          )}
        </div>
      </header>

      <section className="relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-10 px-8 pb-24">
        <div className="space-y-5">
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">
            Agentic commerce
          </p>
          <h1 className="text-5xl font-semibold tracking-tight text-foreground sm:text-6xl">
            CommercePilot
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
            The AI buyer with a financial conscience.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-status-completed/15 px-3 py-1 font-mono text-xs uppercase tracking-wide text-status-completed">
            Completed
          </span>
          <span className="rounded-full bg-status-pending/15 px-3 py-1 font-mono text-xs uppercase tracking-wide text-status-pending">
            Pending
          </span>
          <span className="rounded-full bg-status-denied/15 px-3 py-1 font-mono text-xs uppercase tracking-wide text-status-denied">
            Denied
          </span>
        </div>

        <div className="flex flex-wrap items-end gap-6">
          <div>
            <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Available to spend
            </p>
            <p className="font-mono text-3xl tabular-nums text-foreground">₹0.00</p>
          </div>
          <Button type="button" size="lg" disabled>
            Pay Now
          </Button>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/products"
        element={
          <ProtectedRoute roles={["merchant_admin"]}>
            <ProductManagementPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/policy"
        element={
          <ProtectedRoute roles={["customer"]}>
            <PolicySettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/shop"
        element={
          <ProtectedRoute roles={["customer"]}>
            <AICommerceDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/shop/:intentId"
        element={
          <ProtectedRoute roles={["customer"]}>
            <AIShoppingChat />
          </ProtectedRoute>
        }
      />
      <Route
        path="/shop/:intentId/compare"
        element={
          <ProtectedRoute roles={["customer"]}>
            <ProductComparisonPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/shop/:intentId/review"
        element={
          <ProtectedRoute roles={["customer"]}>
            <PurchaseReviewPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
