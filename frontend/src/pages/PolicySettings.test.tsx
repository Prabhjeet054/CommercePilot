import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PolicySettingsPage from "@/pages/PolicySettings";

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

type StoredPolicy = {
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installStore(initial: StoredPolicy | null) {
  let stored = initial;
  authFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/products")) {
      return jsonResponse(200, {
        products: [
          { category: "Electronics" },
          { category: "Sports" },
          { category: "Travel" },
        ],
        total: 3,
      });
    }
    if (path === "/policies/me") {
      if (!stored) {
        return jsonResponse(404, { error: "NO_POLICY_CONFIGURED", message: "Set up your policy" });
      }
      return jsonResponse(200, stored);
    }
    if (path === "/policies" && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as {
        maxAutonomousAmount: number;
        dailySpendingLimit: number;
        approvalThreshold: number;
        allowedCategories: string[];
        blockedCategories: string[];
        trustedMerchants: string[];
        autonomousEnabled: boolean;
        maxAutonomousTxnsPerDay: number;
        userId?: string;
      };
      expect(payload.userId).toBeUndefined();
      stored = {
        id: stored?.id ?? "policy-1",
        userId: "user-1",
        maxAutonomousAmount: Number(payload.maxAutonomousAmount).toFixed(2),
        dailySpendingLimit: Number(payload.dailySpendingLimit).toFixed(2),
        approvalThreshold: Number(payload.approvalThreshold).toFixed(2),
        allowedCategories: payload.allowedCategories,
        blockedCategories: payload.blockedCategories,
        trustedMerchants: payload.trustedMerchants,
        autonomousEnabled: payload.autonomousEnabled,
        maxAutonomousTxnsPerDay: payload.maxAutonomousTxnsPerDay,
      };
      return jsonResponse(201, stored);
    }
    return jsonResponse(500, { error: "unexpected" });
  });
}

describe("PolicySettings form persist", () => {
  beforeEach(() => {
    authFetch.mockReset();
    logout.mockReset();
  });

  it("submits the demo policy and still shows those values after a reload", async () => {
    const user = userEvent.setup();
    installStore(null);

    const first = render(
      <MemoryRouter>
        <PolicySettingsPage />
      </MemoryRouter>,
    );

    await screen.findByText(/set up your policy/i);

    const maxAuto = screen.getByLabelText(/max autonomous \(₹\)/i);
    const daily = screen.getByLabelText(/daily limit \(₹\)/i);
    const approval = screen.getByLabelText(/approval threshold \(₹\)/i);

    await user.clear(maxAuto);
    await user.type(maxAuto, "5000");
    await user.clear(daily);
    await user.type(daily, "10000");
    await user.clear(approval);
    await user.type(approval, "5000");

    await user.click(screen.getByRole("button", { name: /save policy/i }));

    await waitFor(() => {
      expect(screen.getByText(/autonomous purchases up to/i)).toBeTruthy();
    });

    first.unmount();
    render(
      <MemoryRouter>
        <PolicySettingsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect((screen.getByLabelText(/max autonomous \(₹\)/i) as HTMLInputElement).value).toBe("5000");
      expect((screen.getByLabelText(/daily limit \(₹\)/i) as HTMLInputElement).value).toBe("10000");
      expect((screen.getByLabelText(/approval threshold \(₹\)/i) as HTMLInputElement).value).toBe(
        "5000",
      );
    });
  });
});
