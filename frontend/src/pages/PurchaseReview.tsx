import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CustomerShell } from "@/components/CustomerShell";
import { useAuth } from "@/lib/auth-context";
import {
  formatPrice,
  getPurchaseIntent,
  type PurchaseIntentView,
} from "@/lib/api/purchase-intents";

export function PurchaseReviewSummary({ view }: { view: PurchaseIntentView }) {
  const product = view.selectedProduct;
  const policy = view.policyDecision;
  const autonomous = view.purchaseMode === "autonomous";
  const allowed = policy?.decision === "ALLOW" || view.result === "POLICY_ALLOWED";
  const needsApproval =
    policy?.decision === "REQUIRE_APPROVAL" || view.result === "APPROVAL_PENDING";
  const denied = policy?.decision === "DENY" || view.result === "POLICY_DENIED";

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-6">
      <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Purchase review</p>
      {product ? (
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">{product.name}</h2>
          <p className="font-mono text-lg tabular-nums text-foreground">{formatPrice(product.price)}</p>
          <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">{product.category}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No product was selected.</p>
      )}

      {policy && (
        <div className="rounded-md border border-border bg-secondary px-4 py-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Policy</p>
          <p className="mt-1 font-mono text-sm text-foreground">
            {policy.decision} · {policy.reasonCode}
          </p>
        </div>
      )}

      {allowed && autonomous && (
        <p className="text-sm text-status-completed">
          Policy allowed this purchase. Continuing automatically — payment is not started in this step.
        </p>
      )}
      {allowed && !autonomous && (
        <p className="text-sm text-status-completed">
          Policy allowed this purchase. Review the summary above; payment is not started in this step.
        </p>
      )}
      {needsApproval && (
        <p className="text-sm text-status-pending">
          This amount needs your approval before any payment can start. Razorpay has not been called.
        </p>
      )}
      {denied && (
        <p className="text-sm text-status-denied">
          Policy denied this purchase. No order was created.
        </p>
      )}
    </div>
  );
}

export default function PurchaseReviewPage() {
  const { intentId } = useParams();
  const { authFetch } = useAuth();
  const query = useQuery({
    queryKey: ["purchase-intent", intentId],
    queryFn: () => getPurchaseIntent(authFetch, intentId ?? ""),
    enabled: Boolean(intentId),
  });

  return (
    <CustomerShell title="Purchase review">
      <section className="mx-auto max-w-3xl space-y-6 px-8 py-10">
        <Link to={intentId ? `/shop/${intentId}` : "/shop"} className="font-mono text-xs text-primary hover:underline">
          Back to request
        </Link>
        {query.isLoading && (
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Loading review</p>
        )}
        {query.isError && <p className="text-sm text-destructive">Could not load this purchase review.</p>}
        {query.data && <PurchaseReviewSummary view={query.data} />}
      </section>
    </CustomerShell>
  );
}
