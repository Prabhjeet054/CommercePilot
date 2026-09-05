import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { AnalyticsApiError, fetchMerchantAnalytics } from "@/lib/api/analytics";
import { Analytics } from "@/pages/Analytics";
import { AdminOrderManagement } from "@/pages/AdminOrderManagement";

export default function MerchantDashboard() {
  const { user, authFetch, logout } = useAuth();

  const analyticsQuery = useQuery({
    queryKey: ["merchant-analytics", user?.id],
    queryFn: () => fetchMerchantAnalytics(authFetch),
    enabled: Boolean(user?.id),
    retry: false,
  });

  const notAssociated =
    analyticsQuery.error instanceof AnalyticsApiError &&
    analyticsQuery.error.code === "MERCHANT_NOT_ASSOCIATED";

  return (
    <main className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-8 py-5">
        <div className="flex items-center gap-6">
          <Link to="/" className="font-mono text-xs tracking-[0.28em] text-muted-foreground">
            CP-CONSOLE
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">Merchant growth</h1>
          <nav className="hidden items-center gap-3 sm:flex">
            <Button asChild variant="outline" size="sm">
              <Link to="/merchant">Dashboard</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/products">Catalog</Link>
            </Button>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs text-muted-foreground">{user?.email}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-12 px-8 py-10">
        {analyticsQuery.isLoading && (
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
            Loading analytics
          </p>
        )}

        {notAssociated && (
          <div
            className="rounded-lg border border-border bg-card p-6 space-y-2"
            data-testid="merchant-not-associated"
          >
            <h2 className="text-xl font-semibold tracking-tight">No merchant associated</h2>
            <p className="text-sm text-muted-foreground">
              This admin account is not linked to a merchant. Analytics stay empty rather than
              querying another tenant&apos;s data. Use a seeded merchant admin (for example{" "}
              <span className="font-mono text-foreground">arjun@apex.commercepilot.demo</span>).
            </p>
          </div>
        )}

        {analyticsQuery.isError && !notAssociated && (
          <p className="text-sm text-destructive" data-testid="analytics-error">
            {analyticsQuery.error instanceof AnalyticsApiError
              ? analyticsQuery.error.message
              : "Could not load analytics."}
          </p>
        )}

        {analyticsQuery.data && (
          <>
            <Analytics data={analyticsQuery.data} />
            <AdminOrderManagement data={analyticsQuery.data} />
          </>
        )}
      </div>
    </main>
  );
}
