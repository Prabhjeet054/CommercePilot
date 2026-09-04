import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_INTENT_PHRASE } from "@/lib/api/purchase-intents";
import AICommerceDashboard from "@/pages/AICommerceDashboard";
import AIShoppingChat from "@/pages/AIShoppingChat";

const authFetch = vi.fn();
const logout = vi.fn();

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      email: "priya@commercepilot.demo",
      role: "customer",
      name: "Priya",
      merchantId: null,
    },
    authFetch,
    logout,
  }),
}));

const PRICE_EVIDENCE = "₹4,499 is within your ₹5,000 budget (ideal ₹4,500)";
const QUALITY_EVIDENCE = "Rating 4.7/5 from 1284 reviews";

const demoFactors = [
  { name: "priceFit", score: 99.98, weight: 0.3, evidence: PRICE_EVIDENCE },
  { name: "preferenceMatch", score: 80, weight: 0.25, evidence: "6 of 8 intent tokens overlap with Apex Stride Runner tags and specs" },
  { name: "quality", score: 94.12, weight: 0.2, evidence: QUALITY_EVIDENCE },
  { name: "specMatch", score: 100, weight: 0.15, evidence: "2 of 2 spec checks matched (running use, distance/cushioning)" },
  { name: "merchantTrust", score: 92.5, weight: 0.1, evidence: "Apex Sports trust score 92.5" },
];

const pipelineAllow = {
  id: "intent-shoe-1",
  status: "POLICY_ALLOWED",
  result: "POLICY_ALLOWED",
  purchaseMode: "autonomous",
  intent: {
    category: "Sports",
    extractedCategory: "running_shoes",
    budget: 5000,
    currency: "INR",
    purpose: "running shoes",
    usage: "run around 25 km every week",
    priority: "best",
    purchaseMode: "autonomous",
    confidence: 0.82,
    hasAdditionalUnparsedRequest: false,
  },
  rankedCandidates: [
    {
      productId: "shoe-1",
      name: "Apex Stride Runner",
      category: "Sports",
      price: "4499.00",
      merchantId: "merchant-apex",
      score: 91.91,
      rank: 1,
      selected: true,
      factors: demoFactors,
    },
    {
      productId: "tempo-1",
      name: "Apex Tempo Racer",
      category: "Sports",
      price: "3999.00",
      merchantId: "merchant-apex",
      score: 66.59,
      rank: 2,
      selected: false,
      factors: demoFactors.map((factor) => ({ ...factor, evidence: factor.evidence })),
    },
  ],
  selectedProduct: {
    id: "shoe-1",
    name: "Apex Stride Runner",
    price: "4499.00",
    category: "Sports",
    merchantId: "merchant-apex",
  },
  policyDecision: {
    decision: "ALLOW",
    reasonCode: "WITHIN_POLICY",
    evaluationId: "eval-1",
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderShop(path = "/shop") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/shop" element={<AICommerceDashboard />} />
          <Route path="/shop/:intentId" element={<AIShoppingChat />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AI shopping chat demo phrase", () => {
  beforeEach(() => {
    authFetch.mockReset();
    logout.mockReset();
  });

  it("submits the PRD demo phrase and renders intent, ranking evidence, and ALLOW", async () => {
    const user = userEvent.setup();
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/purchase-intents" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as { text: string; purchaseMode: string };
        expect(payload.text).toBe(DEMO_INTENT_PHRASE);
        expect(payload.purchaseMode).toBe("autonomous");
        return jsonResponse(201, pipelineAllow);
      }
      if (path === "/purchase-intents") {
        return jsonResponse(200, { intents: [] });
      }
      return jsonResponse(404, { error: "NOT_FOUND" });
    });

    renderShop();
    await screen.findByLabelText(/shopping goal/i);

    await user.click(screen.getByRole("button", { name: /use demo phrase/i }));
    await user.click(screen.getByRole("button", { name: /ask commercepilot/i }));

    await waitFor(
      () => {
        expect(screen.getAllByText("Apex Stride Runner").length).toBeGreaterThan(0);
        expect(screen.getByText("ALLOW · WITHIN_POLICY")).toBeTruthy();
      },
      { timeout: 4000 },
    );

    await user.click(screen.getByRole("button", { name: "Apex Stride Runner" }));
    expect(screen.getByText(PRICE_EVIDENCE)).toBeTruthy();
    expect(screen.getByText(QUALITY_EVIDENCE)).toBeTruthy();
    expect(screen.getByText(/continue to payment when you are ready/i)).toBeTruthy();
    expect(screen.getByText(/intent extracted/i)).toBeTruthy();
    expect(screen.getAllByText(/products found/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ranking/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/policy result/i)).toBeTruthy();
  });

  it("shows a friendly message when nothing in the catalog matches", async () => {
    const user = userEvent.setup();
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/purchase-intents" && init?.method === "POST") {
        return jsonResponse(201, {
          id: "intent-empty",
          status: "INTENT_EXTRACTED",
          result: "NO_MATCHING_PRODUCTS",
          purchaseMode: "manual",
          intent: { category: "glow moss", budget: 2000, purpose: "glow moss" },
          rankedCandidates: [],
          selectedProduct: null,
          policyDecision: null,
        });
      }
      if (path === "/purchase-intents") {
        return jsonResponse(200, { intents: [] });
      }
      return jsonResponse(404, { error: "NOT_FOUND" });
    });

    renderShop();
    await screen.findByLabelText(/shopping goal/i);
    await user.type(screen.getByLabelText(/shopping goal/i), "buy glow moss under ₹2000");
    await user.click(screen.getByRole("button", { name: /ask commercepilot/i }));

    await waitFor(
      () => {
        expect(screen.getByText(/couldn't find a product that matches/i)).toBeTruthy();
      },
      { timeout: 4000 },
    );
  });

  it("renders a friendly message for an intent extraction failure", async () => {
    const user = userEvent.setup();
    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/purchase-intents" && init?.method === "POST") {
        return jsonResponse(400, {
          error: "IntentExtractionError",
          message: "I couldn't understand that request, could you rephrase?",
        });
      }
      if (path === "/purchase-intents") {
        return jsonResponse(200, { intents: [] });
      }
      return jsonResponse(500, { error: "unexpected" });
    });

    renderShop();
    await screen.findByLabelText(/shopping goal/i);
    await user.type(screen.getByLabelText(/shopping goal/i), "asdf");
    await user.click(screen.getByRole("button", { name: /ask commercepilot/i }));

    await waitFor(() => {
      expect(screen.getByText(/couldn't understand that request, could you rephrase/i)).toBeTruthy();
    });
  });
});
