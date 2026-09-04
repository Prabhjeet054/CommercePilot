import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { CustomerShell } from "@/components/CustomerShell";
import { useAuth } from "@/lib/auth-context";
import {
  getPurchaseIntent,
  PurchaseIntentApiError,
  type PurchaseIntentView,
} from "@/lib/api/purchase-intents";
import { RankedCandidatesTable } from "@/pages/ProductComparison";
import { PurchaseReviewSummary } from "@/pages/PurchaseReview";

const STAGES = [
  { id: "intent", label: "Intent extracted" },
  { id: "discovery", label: "Products found" },
  { id: "ranking", label: "Ranking" },
  { id: "policy", label: "Policy result" },
] as const;

function maxStage(view: PurchaseIntentView): number {
  if (view.result === "NO_MATCHING_PRODUCTS") {
    return 1;
  }
  if (view.policyDecision) {
    return 3;
  }
  if (view.rankedCandidates.some((row) => row.selected)) {
    return 2;
  }
  if (view.rankedCandidates.length > 0) {
    return 1;
  }
  return 0;
}

export default function AIShoppingChat() {
  const { intentId } = useParams();
  const { authFetch } = useAuth();
  const [revealed, setRevealed] = useState(0);

  const query = useQuery({
    queryKey: ["purchase-intent", intentId],
    queryFn: () => getPurchaseIntent(authFetch, intentId ?? ""),
    enabled: Boolean(intentId),
  });

  const view = query.data;
  const ceiling = view ? maxStage(view) : -1;

  useEffect(() => {
    setRevealed(0);
  }, [intentId, view?.id]);

  useEffect(() => {
    if (!view || ceiling < 0) {
      return;
    }
    if (revealed >= ceiling) {
      return;
    }
    const timer = window.setTimeout(() => setRevealed((value) => value + 1), 280);
    return () => window.clearTimeout(timer);
  }, [view, revealed, ceiling]);

  const errorMessage =
    query.error instanceof PurchaseIntentApiError
      ? query.error.message
      : query.isError
        ? "I couldn't load that request."
        : null;

  return (
    <CustomerShell title="Shopping chat">
      <section className="mx-auto max-w-5xl space-y-8 px-8 py-10">
        <Link to="/shop" className="font-mono text-xs text-primary hover:underline">
          All requests
        </Link>

        {query.isLoading && (
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
            Restoring pipeline
          </p>
        )}
        {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

        {view && (
          <>
            <div className="rounded-lg border border-border bg-card p-6">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">You</p>
              <p className="mt-2 text-sm leading-relaxed">{view.rawText}</p>
            </div>

            <ol className="grid gap-3 sm:grid-cols-4">
              {STAGES.map((stage, index) => {
                const active = revealed >= index && index <= ceiling;
                return (
                  <li
                    key={stage.id}
                    className={`rounded-md border px-3 py-3 font-mono text-xs uppercase tracking-[0.18em] ${
                      active
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {stage.label}
                  </li>
                );
              })}
            </ol>

            {revealed >= 0 && (
              <div className="rounded-lg border border-border bg-card p-6">
                <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Structured intent</p>
                <pre className="mt-3 overflow-x-auto font-mono text-xs text-muted-foreground">
                  {JSON.stringify(view.intent, null, 2)}
                </pre>
              </div>
            )}

            {revealed >= 1 && (
              <div className="space-y-3">
                <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">
                  {view.rankedCandidates.length} products found
                </p>
                {view.result === "NO_MATCHING_PRODUCTS" && (
                  <p className="text-sm text-muted-foreground">
                    I couldn't find a product that matches that request. Try a different category or budget.
                  </p>
                )}
              </div>
            )}

            {revealed >= 2 && view.rankedCandidates.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Ranking</p>
                  <Link
                    to={`/shop/${view.id}/compare`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    Open comparison
                  </Link>
                </div>
                <RankedCandidatesTable candidates={view.rankedCandidates} />
              </div>
            )}

            {revealed >= 3 && (
              <div className="space-y-3">
                <Link
                  to={`/shop/${view.id}/review`}
                  className="font-mono text-xs text-primary hover:underline"
                >
                  Open purchase review
                </Link>
                <PurchaseReviewSummary view={view} />
              </div>
            )}
          </>
        )}
      </section>
    </CustomerShell>
  );
}
