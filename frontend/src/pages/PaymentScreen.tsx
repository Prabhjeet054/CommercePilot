import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CustomerShell } from "@/components/CustomerShell";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import {
  createPaymentOrder,
  PaymentsApiError,
  verifyPayment,
  type CreateOrderResponse,
} from "@/lib/api/payments";
import { formatPrice, getPurchaseIntent } from "@/lib/api/purchase-intents";
import {
  CHECKOUT_THEME_COLOR,
  openCheckout,
  type RazorpayCheckoutSuccess,
} from "@/lib/razorpay-checkout";

/** How long we show "payment received, confirming..." before soft timeout copy. */
const CONFIRMING_SOFT_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 1_500;

type UiState =
  | { kind: "idle" }
  | { kind: "checkout_open" }
  | { kind: "dismissed" }
  | { kind: "verifying"; payment: RazorpayCheckoutSuccess }
  | { kind: "confirming"; payment: RazorpayCheckoutSuccess; orderState: string; since: number }
  | { kind: "verify_error"; message: string; reasonCode?: string };

function formatPaise(amountInPaise: number, currency: string): string {
  if (currency === "INR") {
    return formatPrice((amountInPaise / 100).toFixed(2));
  }
  return `${(amountInPaise / 100).toFixed(2)} ${currency}`;
}

export default function PaymentScreen() {
  const { intentId } = useParams();
  const navigate = useNavigate();
  const { authFetch, user } = useAuth();
  const [ui, setUi] = useState<UiState>({ kind: "idle" });
  const [confirmingTimedOut, setConfirmingTimedOut] = useState(false);
  const successHandled = useRef(false);
  const autoOpenedFor = useRef<string | null>(null);

  const intentQuery = useQuery({
    queryKey: ["purchase-intent", intentId],
    queryFn: () => getPurchaseIntent(authFetch, intentId ?? ""),
    enabled: Boolean(intentId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const orderState = query.state.data?.order?.state;
      if (status === "COMPLETED" || orderState === "COMPLETED") {
        return false;
      }
      if (ui.kind === "confirming") {
        return POLL_INTERVAL_MS;
      }
      return false;
    },
  });

  const alreadyCompleted =
    intentQuery.data?.status === "COMPLETED" || intentQuery.data?.order?.state === "COMPLETED";

  useEffect(() => {
    if (alreadyCompleted && intentId) {
      navigate(`/shop/${intentId}/success`, { replace: true });
    }
  }, [alreadyCompleted, intentId, navigate]);

  useEffect(() => {
    if (ui.kind !== "confirming") {
      setConfirmingTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setConfirmingTimedOut(true), CONFIRMING_SOFT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [ui.kind]);

  const orderQuery = useQuery({
    queryKey: ["payments-create-order", intentId],
    queryFn: () => createPaymentOrder(authFetch, intentId ?? ""),
    enabled: Boolean(intentId) && !alreadyCompleted,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const order = orderQuery.data ?? null;

  const launchCheckout = useCallback(
    async (checkoutOrder: CreateOrderResponse) => {
      successHandled.current = false;
      setUi({ kind: "checkout_open" });
      try {
        await openCheckout({
          key: checkoutOrder.keyId,
          amount: checkoutOrder.amount,
          currency: checkoutOrder.currency,
          name: "CommercePilot",
          description: intentQuery.data?.selectedProduct?.name ?? "Purchase",
          order_id: checkoutOrder.razorpayOrderId,
          prefill: {
            name: user?.name ?? undefined,
            email: user?.email ?? undefined,
            contact: undefined,
          },
          theme: { color: CHECKOUT_THEME_COLOR },
          modal: {
            ondismiss: () => {
              if (successHandled.current) {
                return;
              }
              setUi({ kind: "dismissed" });
            },
          },
          handler: (response) => {
            successHandled.current = true;
            void (async () => {
              setUi({ kind: "verifying", payment: response });
              try {
                const result = await verifyPayment(authFetch, response);
                if (result.verified) {
                  // Provisional only — success UI waits for backend COMPLETED (webhook).
                  setUi({
                    kind: "confirming",
                    payment: response,
                    orderState: result.orderState ?? "PAYMENT_AUTHORIZED",
                    since: Date.now(),
                  });
                  void intentQuery.refetch();
                  return;
                }
                setUi({
                  kind: "verify_error",
                  message: result.message ?? "Payment could not be verified yet.",
                });
              } catch (err) {
                const message =
                  err instanceof PaymentsApiError
                    ? err.message
                    : "Payment captured in Checkout, but verification failed.";
                setUi({
                  kind: "verify_error",
                  message,
                  reasonCode: err instanceof PaymentsApiError ? err.reasonCode : undefined,
                });
              }
            })();
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not open Checkout.";
        setUi({ kind: "verify_error", message });
      }
    },
    [authFetch, intentQuery, user?.email, user?.name],
  );

  /** Open Checkout once the order is ready (Pay Now remains as a fallback). */
  useEffect(() => {
    if (!order || alreadyCompleted) {
      return;
    }
    if (autoOpenedFor.current === order.razorpayOrderId) {
      return;
    }
    if (ui.kind === "confirming" || ui.kind === "verifying") {
      return;
    }
    autoOpenedFor.current = order.razorpayOrderId;
    void launchCheckout(order);
  }, [order, launchCheckout, alreadyCompleted, ui.kind]);

  const product = intentQuery.data?.selectedProduct;
  const orderErrorMessage =
    orderQuery.error instanceof PaymentsApiError
      ? orderQuery.error.message
      : orderQuery.isError
        ? "Could not start payment. Please try again."
        : null;

  return (
    <CustomerShell title="Payment">
      <section className="mx-auto max-w-3xl space-y-6 px-8 py-10">
        <Link
          to={intentId ? `/shop/${intentId}/review` : "/shop"}
          className="font-mono text-xs text-primary hover:underline"
        >
          Back to purchase review
        </Link>

        <div className="space-y-4 rounded-lg border border-border bg-card p-6">
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Payment</p>
          {product ? (
            <div className="space-y-1">
              <h2 className="text-2xl font-semibold tracking-tight">{product.name}</h2>
              <p className="font-mono text-lg tabular-nums text-foreground">
                {formatPrice(product.price)}
              </p>
            </div>
          ) : (
            <h2 className="text-2xl font-semibold tracking-tight">Complete payment</h2>
          )}

          {order && (
            <div className="rounded-md border border-border bg-secondary px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                Razorpay order
              </p>
              <p className="mt-1 font-mono text-sm text-foreground" data-testid="razorpay-order-id">
                {order.razorpayOrderId}
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {formatPaise(order.amount, order.currency)} · {order.currency} · key {order.keyId}
              </p>
            </div>
          )}

          {orderQuery.isLoading && (
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
              Creating Razorpay order
            </p>
          )}

          {orderErrorMessage && (
            <div className="space-y-3" data-testid="create-order-error">
              <p className="text-sm text-destructive">{orderErrorMessage}</p>
              <Button type="button" onClick={() => void orderQuery.refetch()}>
                Retry create order
              </Button>
            </div>
          )}

          {order && (ui.kind === "idle" || ui.kind === "checkout_open") && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Opening Razorpay Checkout. If the modal does not appear, use Pay Now.
              </p>
              <Button type="button" size="lg" onClick={() => void launchCheckout(order)}>
                Pay Now
              </Button>
            </div>
          )}

          {ui.kind === "dismissed" && order && (
            <div className="space-y-3" data-testid="payment-dismissed">
              <p className="text-sm text-status-pending">Payment not completed.</p>
              <p className="text-sm text-muted-foreground">
                Your Razorpay order is unchanged. Retry reopens Checkout with the same order id.
              </p>
              <Button type="button" size="lg" onClick={() => void launchCheckout(order)}>
                Retry payment
              </Button>
            </div>
          )}

          {ui.kind === "verifying" && (
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
              Submitting payment for verification
            </p>
          )}

          {ui.kind === "confirming" && (
            <div className="space-y-3" data-testid="payment-confirming">
              <p className="text-sm text-status-pending">payment received, confirming...</p>
              <p className="text-sm text-muted-foreground">
                Checkout succeeded and the signature was verified. Waiting for the server to confirm
                capture (Razorpay webhook) before showing success.
              </p>
              <p className="font-mono text-xs text-muted-foreground" data-testid="payment-order-state">
                {intentQuery.data?.order?.state ?? ui.orderState} · payment{" "}
                {ui.payment.razorpay_payment_id}
              </p>
              {confirmingTimedOut && (
                <p className="text-sm text-muted-foreground" data-testid="payment-confirming-delayed">
                  Still confirming. You can leave this page open — we will not mark the order
                  complete until the backend reports COMPLETED.
                </p>
              )}
            </div>
          )}

          {ui.kind === "verify_error" && (
            <div className="space-y-3" data-testid="payment-verify-error">
              <p className="text-sm text-status-denied">{ui.message}</p>
              {ui.reasonCode && (
                <p className="font-mono text-xs text-muted-foreground">{ui.reasonCode}</p>
              )}
              {order && (
                <Button type="button" size="lg" onClick={() => void launchCheckout(order)}>
                  Retry payment
                </Button>
              )}
            </div>
          )}
        </div>
      </section>
    </CustomerShell>
  );
}
