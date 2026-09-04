import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApprovalScreen from "@/pages/ApprovalScreen";

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

const pendingApproval = {
  id: "approval-1",
  purchaseIntentId: "intent-laptop-1",
  productId: "laptop-1",
  productName: "Nova Ultrabook 16",
  merchantName: "Nova Electronics",
  amount: "120000.00",
  reasonCode: "DAILY_LIMIT_EXCEEDED",
  reason: "This purchase would exceed your daily spending limit of ₹10,000.",
  approvalThreshold: "5000.00",
  dailySpendingLimit: "10000.00",
  status: "PENDING",
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  consumedAt: null,
  createdAt: new Date().toISOString(),
  rationale: ["₹1,20,000 matches the requested laptop budget", "Nova Electronics trust score 81"],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderApproval(path = "/approvals/approval-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/approvals/:id" element={<ApprovalScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ApprovalScreen", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    authFetch.mockReset();
    logout.mockReset();
  });

  it("shows product, amount, merchant, policy reason, and ranking rationale", async () => {
    authFetch.mockImplementation(async (path: string) => {
      if (path === "/approvals/approval-1") {
        return jsonResponse(200, pendingApproval);
      }
      return jsonResponse(404, { error: "NOT_FOUND" });
    });

    renderApproval();

    expect(await screen.findByRole("heading", { name: /Nova Ultrabook 16/i })).toBeTruthy();
    expect(screen.getAllByText(/₹1,20,000/).length).toBeGreaterThan(0);
    expect(screen.getByText("Nova Electronics")).toBeTruthy();
    expect(screen.getByText(/daily spending limit of ₹10,000/i)).toBeTruthy();
    expect(screen.getByText("DAILY_LIMIT_EXCEEDED")).toBeTruthy();
    expect(screen.getByText(/approval threshold/i)).toBeTruthy();
    expect(screen.getByText(/matches the requested laptop budget/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeTruthy();
  });

  it("disables Approve and Reject immediately on click, before the response returns", async () => {
    const user = userEvent.setup();
    let resolveDecision: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveDecision = resolve;
    });

    authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/approvals/approval-1/decision" && init?.method === "POST") {
        return pending;
      }
      if (path === "/approvals/approval-1") {
        return jsonResponse(200, pendingApproval);
      }
      return jsonResponse(404, { error: "NOT_FOUND" });
    });

    renderApproval();
    const approve = await screen.findByRole("button", { name: /^approve$/i });
    const reject = screen.getByRole("button", { name: /^reject$/i });

    await user.click(approve);

    await waitFor(() => {
      expect((approve as HTMLButtonElement).disabled).toBe(true);
      expect((reject as HTMLButtonElement).disabled).toBe(true);
    });

    resolveDecision?.(
      jsonResponse(200, {
        ...pendingApproval,
        status: "APPROVED",
        consumedAt: new Date().toISOString(),
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("approval-status").textContent).toMatch(/approved/i);
    });
  });
});
