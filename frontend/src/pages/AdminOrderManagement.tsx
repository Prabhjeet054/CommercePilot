import type { MerchantAnalytics } from "@/lib/api/analytics";

function formatInr(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    return `₹${amount}`;
  }
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
}

function statusTone(status: string): string {
  if (status.includes("DENIED") || status.includes("FAILED") || status.includes("REJECTED")) {
    return "text-status-denied";
  }
  if (status.includes("PENDING")) {
    return "text-status-pending";
  }
  return "text-muted-foreground";
}

type Props = {
  data: MerchantAnalytics;
};

/** Flagged AI intents + recent completed orders for merchant inspection. */
export function AdminOrderManagement({ data }: Props) {
  return (
    <section className="space-y-8" data-testid="admin-order-management">
      <div className="space-y-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Inspection</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">Flagged AI intents</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Denied, rejected, approval-pending, and verification-failed intents that selected your
            products.
          </p>
        </div>

        {data.flaggedIntents.length === 0 ? (
          <p
            className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
            data-testid="flagged-empty"
          >
            No flagged intents for your catalog right now.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm" data-testid="flagged-feed">
              <thead className="bg-secondary font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                  <th className="px-4 py-3 font-medium">Intent</th>
                </tr>
              </thead>
              <tbody>
                {data.flaggedIntents.map((row) => (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className={`px-4 py-3 font-mono text-xs ${statusTone(row.status)}`}>
                      {row.status}
                    </td>
                    <td className="px-4 py-3">{row.selectedProductName ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {row.reasonCode ?? "—"}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-muted-foreground" title={row.rawText}>
                      {row.rawText}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
            Recent completed
          </p>
          <h3 className="text-lg font-semibold tracking-tight">AI-assisted orders</h3>
        </div>

        {data.recentCompletedOrders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No completed orders yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm" data-testid="completed-orders">
              <thead className="bg-secondary font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {data.recentCompletedOrders.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="px-4 py-3">{row.productName}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{formatInr(row.amount)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
