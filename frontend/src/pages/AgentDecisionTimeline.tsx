import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CustomerShell } from "@/components/CustomerShell";
import { useAuth } from "@/lib/auth-context";

export type TimelineEvent = {
  id: string;
  action: string;
  actor: string;
  payload: unknown;
  correlationId: string | null;
  createdAt: string;
};

const ACTION_LABELS: Record<string, string> = {
  intent_received: "Intent received",
  intent_extracted: "Intent extracted",
  products_searched: "Products searched",
  products_ranked: "Products ranked",
  recommendation_created: "Recommendation created",
  policy_evaluated: "Policy evaluated",
  approval_requested: "Approval requested",
  approval_granted: "Approval granted",
  approval_rejected: "Approval rejected",
  order_created: "Order created",
  payment_initiated: "Payment initiated",
  payment_verified: "Payment verified",
  webhook_received: "Webhook received",
  order_completed: "Order completed",
  payment_failed: "Payment failed",
};

function labelFor(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

function summarizePayload(action: string, payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const row = payload as Record<string, unknown>;
  if (action === "policy_evaluated") {
    return `${String(row.decision ?? "")} · ${String(row.reasonCode ?? "")}`.trim();
  }
  if (action === "recommendation_created") {
    const name = typeof row.name === "string" ? row.name : null;
    const price = row.price !== undefined ? `₹${row.price}` : null;
    return [name, price].filter(Boolean).join(" · ");
  }
  if (action === "payment_initiated" || action === "payment_verified") {
    return typeof row.razorpayOrderId === "string" ? row.razorpayOrderId : null;
  }
  if (action === "order_completed" || action === "webhook_received") {
    return typeof row.eventType === "string" ? row.eventType : null;
  }
  return null;
}

async function fetchTimeline(
  authFetch: (path: string, init?: RequestInit) => Promise<Response>,
  intentId: string,
): Promise<{ purchaseIntentId: string; events: TimelineEvent[] }> {
  const response = await authFetch(`/agent/decisions/${intentId}/timeline`);
  if (!response.ok) {
    throw new Error(response.status === 404 ? "NOT_FOUND" : "REQUEST_FAILED");
  }
  return (await response.json()) as { purchaseIntentId: string; events: TimelineEvent[] };
}

export default function AgentDecisionTimelinePage() {
  const { intentId } = useParams();
  const { authFetch } = useAuth();

  const query = useQuery({
    queryKey: ["agent-timeline", intentId],
    queryFn: () => fetchTimeline(authFetch, intentId ?? ""),
    enabled: Boolean(intentId),
  });

  return (
    <CustomerShell title="Decision timeline">
      <section className="mx-auto max-w-3xl space-y-6 px-8 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            to={intentId ? `/shop/${intentId}` : "/shop"}
            className="font-mono text-xs text-primary hover:underline"
          >
            Back to request
          </Link>
          {intentId && (
            <Link
              to={`/shop/${intentId}/success`}
              className="font-mono text-xs text-muted-foreground hover:underline"
            >
              Order success
            </Link>
          )}
        </div>

        <div className="space-y-4 rounded-lg border border-border bg-card p-6" data-testid="agent-timeline">
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">
            Agent decision timeline
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">What the agent did</h1>
          <p className="text-sm text-muted-foreground">
            Append-only audit of this purchase intent — chronological, inspectable, dispute-ready.
          </p>

          {query.isLoading && (
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
              Loading timeline
            </p>
          )}

          {query.isError && (
            <p className="text-sm text-destructive" data-testid="agent-timeline-error">
              Could not load this timeline.
            </p>
          )}

          {query.data && query.data.events.length === 0 && (
            <p className="text-sm text-muted-foreground">No audit events recorded yet.</p>
          )}

          {query.data && query.data.events.length > 0 && (
            <ol className="relative space-y-0 border-l border-border pl-6">
              {query.data.events.map((event) => {
                const summary = summarizePayload(event.action, event.payload);
                return (
                  <li
                    key={event.id}
                    className="relative pb-6 last:pb-0"
                    data-testid="agent-timeline-event"
                    data-action={event.action}
                  >
                    <span
                      aria-hidden
                      className="absolute -left-[1.65rem] top-1.5 size-2.5 rounded-full bg-primary"
                    />
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                      {formatWhen(event.createdAt)}
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">{labelFor(event.action)}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {event.action} · actor {event.actor}
                    </p>
                    {summary && <p className="mt-1 text-sm text-muted-foreground">{summary}</p>}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </CustomerShell>
  );
}
