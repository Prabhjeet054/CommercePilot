import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { CustomerShell } from "@/components/CustomerShell";
import { useAuth } from "@/lib/auth-context";
import { formatPrice, getPurchaseIntent, type RankedCandidate } from "@/lib/api/purchase-intents";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 8;

export function RankedCandidatesTable({ candidates }: { candidates: RankedCandidate[] }) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = candidates.slice(0, visible);

  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">No ranked candidates.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="max-h-[28rem] overflow-x-auto overflow-y-auto rounded-md border border-border">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="sticky top-0 bg-card font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Rank</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Score</th>
              <th className="px-3 py-2">Pick</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const expanded = openId === row.productId;
              return (
                <Fragment key={row.productId}>
                  <tr className={cn("border-t border-border", row.selected && "bg-primary/10")}>
                    <td className="px-3 py-2 font-mono tabular-nums">{row.rank}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        aria-expanded={expanded}
                        data-testid={row.selected ? "top-pick-name" : undefined}
                        onClick={() => setOpenId(expanded ? null : row.productId)}
                      >
                        {row.name}
                      </button>
                      <p className="font-mono text-[11px] text-muted-foreground">{row.category}</p>
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">{formatPrice(row.price)}</td>
                    <td className="px-3 py-2 font-mono tabular-nums" data-testid={row.selected ? "top-pick-score" : undefined}>
                      {row.score.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] uppercase tracking-wide">
                      {row.selected ? "Selected" : "—"}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-t border-border bg-secondary/40">
                      <td colSpan={5} className="px-3 py-3">
                        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                          Score breakdown
                        </p>
                        <ul className="space-y-2">
                          {row.factors.map((factor) => (
                            <li key={`${row.productId}-${factor.name}`}>
                              <p className="font-mono text-xs text-foreground">
                                {factor.name} ·{" "}
                                <span data-testid={`factor-score-${row.productId}-${factor.name}`}>
                                  {factor.score.toFixed(2)}
                                </span>{" "}
                                × {factor.weight}
                              </p>
                              <p
                                data-testid={`evidence-${row.productId}-${factor.name}`}
                                className="text-sm text-muted-foreground"
                              >
                                {factor.evidence}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {visible < candidates.length && (
        <button
          type="button"
          className="font-mono text-xs uppercase tracking-[0.24em] text-primary hover:underline"
          onClick={() => setVisible((count) => count + PAGE_SIZE)}
        >
          Show more ({candidates.length - visible} remaining)
        </button>
      )}
    </div>
  );
}

export default function ProductComparisonPage() {
  const { intentId } = useParams();
  const { authFetch } = useAuth();
  const query = useQuery({
    queryKey: ["purchase-intent", intentId],
    queryFn: () => getPurchaseIntent(authFetch, intentId ?? ""),
    enabled: Boolean(intentId),
  });

  return (
    <CustomerShell title="Product comparison">
      <section className="mx-auto max-w-5xl space-y-6 px-8 py-10">
        <Link to={intentId ? `/shop/${intentId}` : "/shop"} className="font-mono text-xs text-primary hover:underline">
          Back to request
        </Link>
        {query.isLoading && (
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Loading ranking</p>
        )}
        {query.isError && <p className="text-sm text-destructive">Could not load ranked candidates.</p>}
        {query.data && <RankedCandidatesTable candidates={query.data.rankedCandidates} />}
      </section>
    </CustomerShell>
  );
}
