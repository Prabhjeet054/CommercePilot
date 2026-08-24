import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { CATEGORIES } from "@/lib/catalog-schema";
import {
  DEMO_POLICY_DEFAULTS,
  parseTrustedMerchants,
  policyWriteSchema,
  summarizePolicy,
  type PolicyFormInput,
} from "@/lib/policy-schema";

type PolicyDto = {
  id: string;
  userId: string;
  maxAutonomousAmount: string;
  dailySpendingLimit: string;
  approvalThreshold: string;
  allowedCategories: string[];
  blockedCategories: string[];
  trustedMerchants: string[];
  autonomousEnabled: boolean;
  maxAutonomousTxnsPerDay: number;
};

const inputClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-ring focus-visible:ring-2";

function dtoToForm(policy: PolicyDto): PolicyFormInput {
  return {
    maxAutonomousAmount: Number(policy.maxAutonomousAmount),
    dailySpendingLimit: Number(policy.dailySpendingLimit),
    approvalThreshold: Number(policy.approvalThreshold),
    allowedCategories: policy.allowedCategories,
    blockedCategories: policy.blockedCategories,
    trustedMerchants: policy.trustedMerchants.join(", "),
    autonomousEnabled: policy.autonomousEnabled,
    maxAutonomousTxnsPerDay: policy.maxAutonomousTxnsPerDay,
  };
}

function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export default function PolicySettingsPage() {
  const { user, authFetch, logout } = useAuth();
  const [catalogCategories, setCatalogCategories] = useState<string[]>([...CATEGORIES]);
  const [setupPrompt, setSetupPrompt] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PolicyFormInput>({
    defaultValues: DEMO_POLICY_DEFAULTS,
  });

  const allowedCategories = watch("allowedCategories");
  const blockedCategories = watch("blockedCategories");
  const autonomousEnabled = watch("autonomousEnabled");

  useEffect(() => {
    void (async () => {
      const productsRes = await authFetch("/products?page=1&pageSize=100");
      if (productsRes.ok) {
        const body = (await productsRes.json()) as { products: Array<{ category: string }> };
        const fromCatalog = [...new Set(body.products.map((product) => product.category))];
        setCatalogCategories([...new Set([...CATEGORIES, ...fromCatalog])].sort());
      }

      const response = await authFetch("/policies/me");
      if (response.status === 404) {
        setSetupPrompt(true);
        reset(DEMO_POLICY_DEFAULTS);
        return;
      }
      if (!response.ok) {
        setServerError("Could not load your policy");
        return;
      }
      const policy = (await response.json()) as PolicyDto;
      setSetupPrompt(false);
      reset(dtoToForm(policy));
      setSummary(summarizePolicy(dtoToForm(policy)));
    })();
  }, [authFetch, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const parsed = policyWriteSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === "string") {
          setError(field as keyof PolicyFormInput, { message: issue.message });
        }
      }
      return;
    }

    const merchants = parseTrustedMerchants(values.trustedMerchants);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (merchants.some((id) => !uuid.test(id))) {
      setError("trustedMerchants", { message: "Trusted merchants must be UUIDs" });
      return;
    }

    setServerError(null);
    const response = await authFetch("/policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxAutonomousAmount: parsed.data.maxAutonomousAmount,
        dailySpendingLimit: parsed.data.dailySpendingLimit,
        approvalThreshold: parsed.data.approvalThreshold,
        allowedCategories: parsed.data.allowedCategories,
        blockedCategories: parsed.data.blockedCategories,
        trustedMerchants: merchants,
        autonomousEnabled: parsed.data.autonomousEnabled,
        maxAutonomousTxnsPerDay: parsed.data.maxAutonomousTxnsPerDay,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        fields?: Record<string, string>;
      };
      setServerError(
        body.fields ? (Object.values(body.fields)[0] ?? body.error ?? "Save failed") : (body.error ?? "Save failed"),
      );
      return;
    }

    const saved = (await response.json()) as PolicyDto;
    setSetupPrompt(false);
    reset(dtoToForm(saved));
    setSummary(summarizePolicy(dtoToForm(saved)));
  });

  const categoryOptions = useMemo(() => catalogCategories, [catalogCategories]);

  return (
    <main className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-8 py-5">
        <div className="flex items-center gap-6">
          <Link to="/" className="font-mono text-xs tracking-[0.28em] text-muted-foreground">
            CP-CONSOLE
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">Financial policy</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs text-muted-foreground">{user?.email}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      <section className="mx-auto grid max-w-5xl gap-8 px-8 py-10 lg:grid-cols-[1fr_20rem]">
        <form onSubmit={onSubmit} className="space-y-6 rounded-lg border border-border bg-card p-8">
          {setupPrompt && (
            <p className="rounded-md border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground">
              Set up your policy to enable autonomous purchasing. Defaults match the demo:
              ₹5,000 autonomous / ₹10,000 daily / ₹5,000 approval, categories Electronics,
              Sports, Travel.
            </p>
          )}

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={autonomousEnabled}
              onChange={(event) => setValue("autonomousEnabled", event.target.checked)}
            />
            <span className="text-sm">Enable autonomous purchasing</span>
          </label>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block space-y-2" htmlFor="policy-max-autonomous">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                Max autonomous (₹)
              </span>
              <input
                id="policy-max-autonomous"
                type="number"
                step="0.01"
                min="0"
                className={inputClass}
                {...register("maxAutonomousAmount")}
              />
              {errors.maxAutonomousAmount && (
                <p className="text-sm text-destructive">{errors.maxAutonomousAmount.message}</p>
              )}
            </label>
            <label className="block space-y-2" htmlFor="policy-daily-limit">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                Daily limit (₹)
              </span>
              <input
                id="policy-daily-limit"
                type="number"
                step="0.01"
                min="0"
                className={inputClass}
                {...register("dailySpendingLimit")}
              />
              {errors.dailySpendingLimit && (
                <p className="text-sm text-destructive">{errors.dailySpendingLimit.message}</p>
              )}
            </label>
            <label className="block space-y-2" htmlFor="policy-approval-threshold">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                Approval threshold (₹)
              </span>
              <input
                id="policy-approval-threshold"
                type="number"
                step="0.01"
                min="0"
                className={inputClass}
                {...register("approvalThreshold")}
              />
              {errors.approvalThreshold && (
                <p className="text-sm text-destructive">{errors.approvalThreshold.message}</p>
              )}
            </label>
          </div>

          <label className="block space-y-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Max autonomous txns / day
            </span>
            <input type="number" step="1" min="0" className={inputClass} {...register("maxAutonomousTxnsPerDay")} />
            {errors.maxAutonomousTxnsPerDay && (
              <p className="text-sm text-destructive">{errors.maxAutonomousTxnsPerDay.message}</p>
            )}
          </label>

          <fieldset className="space-y-3">
            <legend className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Allowed categories
            </legend>
            <div className="flex flex-wrap gap-2">
              {categoryOptions.map((category) => {
                const selected = allowedCategories.includes(category);
                return (
                  <button
                    key={`allow-${category}`}
                    type="button"
                    className={`rounded-full border px-3 py-1 font-mono text-xs ${
                      selected
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground"
                    }`}
                    onClick={() => setValue("allowedCategories", toggleValue(allowedCategories, category))}
                  >
                    {category}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Blocked categories
            </legend>
            <div className="flex flex-wrap gap-2">
              {categoryOptions.map((category) => {
                const selected = blockedCategories.includes(category);
                return (
                  <button
                    key={`block-${category}`}
                    type="button"
                    className={`rounded-full border px-3 py-1 font-mono text-xs ${
                      selected
                        ? "border-destructive bg-destructive/15 text-destructive"
                        : "border-border text-muted-foreground"
                    }`}
                    onClick={() => setValue("blockedCategories", toggleValue(blockedCategories, category))}
                  >
                    {category}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label className="block space-y-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Trusted merchant IDs (comma-separated UUIDs)
            </span>
            <input className={inputClass} placeholder="optional" {...register("trustedMerchants")} />
            {errors.trustedMerchants && (
              <p className="text-sm text-destructive">{errors.trustedMerchants.message}</p>
            )}
          </label>

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save policy"}
          </Button>
        </form>

        <aside className="space-y-4 rounded-lg border border-border bg-card p-6">
          <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">Effective policy</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {summary ?? "Save your policy to see a plain-language summary of what the engine will enforce."}
          </p>
        </aside>
      </section>
    </main>
  );
}
