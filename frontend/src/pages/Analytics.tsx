import type { MerchantAnalytics } from "@/lib/api/analytics";

function formatInr(amount: string | number): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) {
    return `₹${amount}`;
  }
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
}

function formatPct(rate: number): string {
  if (!Number.isFinite(rate) || rate === 0) {
    return "0%";
  }
  return `${(rate * 100).toFixed(1)}%`;
}

type AnalyticsProps = {
  data: MerchantAnalytics;
};

/** Metric cards for AI-assisted GMV, conversion, AOV, and top products. */
export function Analytics({ data }: AnalyticsProps) {
  const empty = data.completedOrderCount === 0;

  return (
    <section className="space-y-6" data-testid="merchant-analytics">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Growth</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">{data.merchantName}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          AI-assisted commerce metrics for your catalog only.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="AI-assisted GMV"
          value={formatInr(data.gmv)}
          hint={`${data.completedOrderCount} completed`}
          testId="metric-gmv"
        />
        <MetricCard
          label="Conversion"
          value={formatPct(data.conversionRate)}
          hint={`${data.completedOrderCount} / ${data.eligibleIntentCount} intents`}
          testId="metric-conversion"
        />
        <MetricCard
          label="Avg order value"
          value={formatInr(data.averageOrderValue)}
          hint="Completed orders"
          testId="metric-aov"
        />
        <MetricCard
          label="Eligible intents"
          value={String(data.eligibleIntentCount)}
          hint="Ranked + selected your products"
          testId="metric-eligible"
        />
      </div>

      {empty && (
        <p
          className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
          data-testid="analytics-empty"
        >
          No completed AI-assisted orders yet. GMV, conversion, and AOV stay at zero until the first
          capture lands.
        </p>
      )}

      <div className="space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
          Top products
        </p>
        {data.topProducts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No product revenue yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-secondary font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Orders</th>
                  <th className="px-4 py-3 font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.topProducts.map((row) => (
                  <tr key={row.productId} className="border-t border-border">
                    <td className="px-4 py-3">{row.name}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{row.orderCount}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{formatInr(row.revenue)}</td>
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

function MetricCard(props: {
  label: string;
  value: string;
  hint: string;
  testId: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid={props.testId}>
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-2 font-mono text-2xl tabular-nums tracking-tight text-foreground">
        {props.value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{props.hint}</p>
    </div>
  );
}
