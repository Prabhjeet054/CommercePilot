import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CustomerShell } from "@/components/CustomerShell";
import { useAuth } from "@/lib/auth-context";
import {
  createPurchaseIntent,
  DEMO_INTENT_PHRASE,
  listPurchaseIntents,
  PurchaseIntentApiError,
  statusTone,
} from "@/lib/api/purchase-intents";

const inputClass =
  "min-h-28 w-full rounded-md border border-input bg-background px-3 py-3 text-sm outline-none ring-ring focus-visible:ring-2";

export default function AICommerceDashboard() {
  const { authFetch } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [purchaseMode, setPurchaseMode] = useState<"autonomous" | "manual">("autonomous");
  const [formError, setFormError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["purchase-intents"],
    queryFn: () => listPurchaseIntents(authFetch),
  });

  const submit = useMutation({
    mutationFn: () => createPurchaseIntent(authFetch, { text: text.trim(), purchaseMode }),
    onSuccess: (view) => {
      queryClient.setQueryData(["purchase-intent", view.id], view);
      void queryClient.invalidateQueries({ queryKey: ["purchase-intents"] });
      navigate(`/shop/${view.id}`);
    },
    onError: (error) => {
      setFormError(
        error instanceof PurchaseIntentApiError
          ? error.message
          : "I couldn't start that purchase. Please try again.",
      );
    },
  });

  return (
    <CustomerShell title="AI shop">
      <section className="mx-auto grid max-w-5xl gap-8 px-8 py-10 lg:grid-cols-[1.2fr_1fr]">
        <form
          className="space-y-4 rounded-lg border border-border bg-card p-8"
          onSubmit={(event) => {
            event.preventDefault();
            setFormError(null);
            if (text.trim().length === 0) {
              setFormError("Describe what you want to buy.");
              return;
            }
            submit.mutate();
          }}
        >
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">New request</p>
          <h2 className="text-2xl font-semibold tracking-tight">What should I buy?</h2>
          <textarea
            aria-label="Shopping goal"
            className={inputClass}
            placeholder={DEMO_INTENT_PHRASE}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={purchaseMode === "autonomous"}
              onChange={(event) => setPurchaseMode(event.target.checked ? "autonomous" : "manual")}
            />
            Buy the best option automatically
          </label>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending ? "Working…" : "Ask CommercePilot"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setText(DEMO_INTENT_PHRASE);
                setPurchaseMode("autonomous");
              }}
            >
              Use demo phrase
            </Button>
          </div>
        </form>

        <aside className="space-y-4 rounded-lg border border-border bg-card p-6">
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Recent intents</p>
          {listQuery.isLoading && (
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Loading</p>
          )}
          {listQuery.isError && (
            <p className="text-sm text-destructive">Could not load recent requests.</p>
          )}
          {listQuery.data && listQuery.data.length === 0 && (
            <p className="text-sm text-muted-foreground">No purchase intents yet. Start with a shopping goal.</p>
          )}
          <ul className="max-h-[28rem] space-y-2 overflow-y-auto">
            {(listQuery.data ?? []).map((row) => {
              const tone = statusTone(row.status);
              return (
                <li key={row.id}>
                  <Link
                    to={`/shop/${row.id}`}
                    className="block rounded-md border border-border px-3 py-3 hover:bg-secondary"
                  >
                    <p className="line-clamp-2 text-sm text-foreground">{row.rawText}</p>
                    <p className="mt-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-wide">
                      <span
                        className={
                          tone === "completed"
                            ? "text-status-completed"
                            : tone === "denied"
                              ? "text-status-denied"
                              : "text-status-pending"
                        }
                      >
                        {row.status.replaceAll("_", " ")}
                      </span>
                      <span className="text-muted-foreground">{row.purchaseMode}</span>
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </aside>
      </section>
    </CustomerShell>
  );
}
