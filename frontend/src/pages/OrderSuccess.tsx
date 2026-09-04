import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CustomerShell } from "@/components/CustomerShell";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { formatPrice, getPurchaseIntent } from "@/lib/api/purchase-intents";

/**
 * Order success — only rendered when the backend independently reports COMPLETED
 * (Phase 18 webhook), never on Checkout handler alone.
 */
export default function OrderSuccessPage() {
  const { intentId } = useParams();
  const { authFetch } = useAuth();

  const intentQuery = useQuery({
    queryKey: ["purchase-intent", intentId],
    queryFn: () => getPurchaseIntent(authFetch, intentId ?? ""),
    enabled: Boolean(intentId),
  });

  const view = intentQuery.data;
  const completed = view?.status === "COMPLETED" || view?.order?.state === "COMPLETED";
  const product = view?.selectedProduct;
  const amount = view?.order?.amount ?? product?.price ?? null;

  return (
    <CustomerShell title="Order complete">
      <section className="mx-auto max-w-3xl space-y-6 px-8 py-10">
        <Link to="/shop" className="font-mono text-xs text-primary hover:underline">
          Back to shop
        </Link>

        <div className="space-y-4 rounded-lg border border-border bg-card p-6" data-testid="order-success">
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Order success</p>

          {intentQuery.isLoading && (
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
              Loading order
            </p>
          )}

          {intentQuery.isError && (
            <p className="text-sm text-destructive">Could not load this purchase.</p>
          )}

          {view && !completed && (
            <div className="space-y-3" data-testid="order-success-not-ready">
              <p className="text-sm text-status-pending">This order is not complete yet.</p>
              <p className="font-mono text-xs text-muted-foreground">
                Status {view.status}
                {view.order ? ` · order ${view.order.state}` : ""}
              </p>
              <Button asChild variant="outline">
                <Link to={`/shop/${view.id}/pay`}>Return to payment</Link>
              </Button>
            </div>
          )}

          {view && completed && (
            <div className="space-y-4">
              <p className="text-sm text-status-completed" data-testid="order-success-banner">
                Purchase completed.
              </p>
              {product && (
                <div className="space-y-1">
                  <h2 className="text-2xl font-semibold tracking-tight" data-testid="order-success-product">
                    {product.name}
                  </h2>
                  {amount && (
                    <p
                      className="font-mono text-lg tabular-nums text-foreground"
                      data-testid="order-success-amount"
                    >
                      {formatPrice(amount)}
                    </p>
                  )}
                </div>
              )}
              {view.order?.razorpayOrderId && (
                <p className="font-mono text-xs text-muted-foreground" data-testid="order-success-razorpay-id">
                  Razorpay order {view.order.razorpayOrderId}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Payment was confirmed by the server after Razorpay webhook capture — not by the
                Checkout callback alone.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <Link to={`/shop/${view.id}/timeline`} data-testid="order-success-timeline-link">
                    View decision timeline
                  </Link>
                </Button>
                <Button asChild>
                  <Link to="/shop">Shop again</Link>
                </Button>
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">
                Full decision timeline is available above.
              </p>
            </div>
          )}
        </div>
      </section>
    </CustomerShell>
  );
}
