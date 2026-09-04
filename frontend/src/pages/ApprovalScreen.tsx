import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CustomerShell } from "@/components/CustomerShell";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import {
  ApprovalApiError,
  decideApproval,
  formatPrice,
  getApproval,
  listPendingApprovals,
  type ApprovalView,
} from "@/lib/api/approvals";

function statusLabel(status: string): string {
  if (status === "APPROVED") {
    return "Approved";
  }
  if (status === "REJECTED") {
    return "Rejected";
  }
  if (status === "EXPIRED") {
    return "Expired";
  }
  return "Pending your decision";
}

function ApprovalDetail({ approval }: { approval: ApprovalView }) {
  const { authFetch } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (decision: "approve" | "reject") => decideApproval(authFetch, approval.id, decision),
    onSuccess: (updated) => {
      void queryClient.setQueryData(["approval", approval.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["approvals-pending"] });
      void queryClient.invalidateQueries({ queryKey: ["purchase-intent", updated.purchaseIntentId] });
    },
  });

  const pending = approval.status === "PENDING";
  const disabled = !pending || busy !== null || mutation.isPending;

  async function onDecide(decision: "approve" | "reject") {
    setError(null);
    setBusy(decision);
    try {
      await mutation.mutateAsync(decision);
    } catch (err) {
      const message = err instanceof ApprovalApiError ? err.message : "Could not submit that decision.";
      setError(message);
      if (!(err instanceof ApprovalApiError) || err.status !== 409) {
        setBusy(null);
      }
    }
  }

  return (
    <div className="space-y-6 rounded-lg border border-border bg-card p-6">
      <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Approval screen</p>
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">{approval.productName}</h2>
        <p className="font-mono text-lg tabular-nums text-foreground">{formatPrice(approval.amount)}</p>
        <p className="text-sm text-muted-foreground">{approval.merchantName}</p>
      </div>

      <div className="rounded-md border border-border bg-secondary px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
          Why approval is required
        </p>
        <p className="mt-1 text-sm text-foreground">{approval.reason}</p>
        {approval.reasonCode && (
          <p className="mt-2 font-mono text-xs text-muted-foreground">{approval.reasonCode}</p>
        )}
        {approval.approvalThreshold && (
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            Approval threshold {formatPrice(approval.approvalThreshold)}
          </p>
        )}
      </div>

      {approval.rationale.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
            AI recommendation
          </p>
          <ul className="space-y-2">
            {approval.rationale.map((line) => (
              <li key={line} className="text-sm leading-relaxed text-foreground">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p data-testid="approval-status" className="text-sm text-status-pending">
        {statusLabel(approval.status)}
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          size="lg"
          disabled={disabled}
          onClick={() => void onDecide("approve")}
        >
          Approve
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disabled}
          onClick={() => void onDecide("reject")}
        >
          Reject
        </Button>
        {approval.status === "APPROVED" && (
          <Button asChild size="lg">
            <Link to={`/shop/${approval.purchaseIntentId}/pay`} data-testid="continue-to-payment">
              Pay Now
            </Link>
          </Button>
        )}
      </div>

      <Link
        to={`/shop/${approval.purchaseIntentId}`}
        className="inline-block font-mono text-xs text-primary hover:underline"
      >
        Back to request
      </Link>
    </div>
  );
}

function PendingList({ approvals }: { approvals: ApprovalView[] }) {
  if (approvals.length === 0) {
    return <p className="text-sm text-muted-foreground">You have no pending approvals.</p>;
  }

  return (
    <ul className="space-y-3">
      {approvals.map((approval) => (
        <li key={approval.id} className="rounded-lg border border-border bg-card p-5">
          <p className="text-lg font-semibold tracking-tight">{approval.productName}</p>
          <p className="font-mono text-sm tabular-nums">{formatPrice(approval.amount)}</p>
          <p className="text-sm text-muted-foreground">{approval.merchantName}</p>
          <Link
            to={`/approvals/${approval.id}`}
            className="mt-3 inline-block font-mono text-xs text-primary hover:underline"
          >
            Open approval screen
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function ApprovalScreen() {
  const { id } = useParams();
  const { authFetch } = useAuth();

  const detailQuery = useQuery({
    queryKey: ["approval", id],
    queryFn: () => getApproval(authFetch, id ?? ""),
    enabled: Boolean(id),
  });

  const pendingQuery = useQuery({
    queryKey: ["approvals-pending"],
    queryFn: () => listPendingApprovals(authFetch),
    enabled: !id,
  });

  return (
    <CustomerShell title="Approvals">
      <section className="mx-auto max-w-3xl space-y-6 px-8 py-10">
        {!id && (
          <Link to="/shop" className="font-mono text-xs text-primary hover:underline">
            Back to shop
          </Link>
        )}
        {id && detailQuery.isLoading && (
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
            Loading approval
          </p>
        )}
        {id && detailQuery.isError && (
          <p className="text-sm text-destructive">
            {detailQuery.error instanceof ApprovalApiError
              ? detailQuery.error.message
              : "Could not load this approval."}
          </p>
        )}
        {id && detailQuery.data && <ApprovalDetail approval={detailQuery.data} />}

        {!id && pendingQuery.isLoading && (
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
            Loading approvals
          </p>
        )}
        {!id && pendingQuery.isError && (
          <p className="text-sm text-destructive">Could not load pending approvals.</p>
        )}
        {!id && pendingQuery.data && <PendingList approvals={pendingQuery.data} />}
      </section>
    </CustomerShell>
  );
}
