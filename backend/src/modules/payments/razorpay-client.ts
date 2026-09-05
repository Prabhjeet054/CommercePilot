import { randomUUID } from "crypto";
import Razorpay from "razorpay";
import { loadEnv } from "../../config/env";

/** Official INR minimum from Razorpay Orders API: 100 paise (₹1.00). */
export const MIN_ORDER_AMOUNT_PAISE = 100;

const PLACEHOLDER_KEY_ID = "rzp_test_replace_me";

export type RazorpayOrderCreateInput = {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
};

export type RazorpayCreatedOrder = {
  id: string;
  amount: number;
  currency: string;
};

/** Subset of GET /v1/orders/:id used for reconciliation. */
export type RazorpayFetchedOrder = {
  id: string;
  status: string;
};

/** Subset of GET /v1/orders/:id/payments used for reconciliation. */
export type RazorpayFetchedPayment = {
  id: string;
  status: string;
  order_id: string;
};

export type RazorpayOrdersClient = {
  createOrder: (input: RazorpayOrderCreateInput) => Promise<RazorpayCreatedOrder>;
  fetchOrder: (razorpayOrderId: string) => Promise<RazorpayFetchedOrder>;
  fetchOrderPayments: (razorpayOrderId: string) => Promise<RazorpayFetchedPayment[]>;
};

export class RazorpayApiError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, options?: { cause?: unknown; statusCode?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RazorpayApiError";
    this.statusCode = options?.statusCode;
  }
}

export class RazorpayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazorpayConfigError";
  }
}

let override: RazorpayOrdersClient | null = null;
let cached: RazorpayOrdersClient | null = null;

export function setRazorpayClientForTests(client: RazorpayOrdersClient | null): void {
  override = client;
  cached = null;
}

function isPlaceholderCredential(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || /replace/i.test(trimmed);
}

export function getRazorpayKeyId(): string {
  const keyId = loadEnv().RAZORPAY_KEY_ID?.trim() ?? "";
  if (!keyId) {
    return PLACEHOLDER_KEY_ID;
  }
  return keyId;
}

export function getRazorpayKeySecret(): string {
  const secret = loadEnv().RAZORPAY_KEY_SECRET?.trim() ?? "";
  if (!secret) {
    throw new RazorpayConfigError("RAZORPAY_KEY_SECRET is not configured");
  }
  return secret;
}

function createDevStubClient(): RazorpayOrdersClient {
  return {
    async createOrder(input: RazorpayOrderCreateInput): Promise<RazorpayCreatedOrder> {
      return {
        id: `order_dev_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        amount: input.amount,
        currency: input.currency,
      };
    },
    async fetchOrder(razorpayOrderId: string): Promise<RazorpayFetchedOrder> {
      return { id: razorpayOrderId, status: "created" };
    },
    async fetchOrderPayments(): Promise<RazorpayFetchedPayment[]> {
      return [];
    },
  };
}

function createSdkClient(): RazorpayOrdersClient {
  const env = loadEnv();
  if (env.NODE_ENV === "test") {
    throw new RazorpayConfigError("Razorpay client must be injected in tests (no live Orders API calls)");
  }
  const key_id = env.RAZORPAY_KEY_ID?.trim() ?? "";
  const key_secret = env.RAZORPAY_KEY_SECRET?.trim() ?? "";
  if (isPlaceholderCredential(key_id) || isPlaceholderCredential(key_secret)) {
    console.warn(
      "[payments] RAZORPAY_KEY_ID/SECRET are placeholders — using in-process Orders stub (no live Razorpay calls).",
    );
    return createDevStubClient();
  }

  const instance = new Razorpay({ key_id, key_secret });
  return {
    async createOrder(input: RazorpayOrderCreateInput): Promise<RazorpayCreatedOrder> {
      try {
        const created = await instance.orders.create({
          amount: input.amount,
          currency: input.currency,
          receipt: input.receipt,
          notes: input.notes,
        });
        return {
          id: String(created.id),
          amount: Number(created.amount),
          currency: String(created.currency),
        };
      } catch (err) {
        throw new RazorpayApiError("Razorpay Orders API failed", { cause: err });
      }
    },
    async fetchOrder(razorpayOrderId: string): Promise<RazorpayFetchedOrder> {
      try {
        const fetched = await instance.orders.fetch(razorpayOrderId);
        return {
          id: String(fetched.id),
          status: String(fetched.status),
        };
      } catch (err) {
        throw new RazorpayApiError("Razorpay Orders fetch failed", { cause: err });
      }
    },
    async fetchOrderPayments(razorpayOrderId: string): Promise<RazorpayFetchedPayment[]> {
      try {
        const page = await instance.orders.fetchPayments(razorpayOrderId);
        const items = Array.isArray(page?.items) ? page.items : [];
        return items.map((payment) => ({
          id: String(payment.id),
          status: String(payment.status),
          order_id: String(payment.order_id ?? razorpayOrderId),
        }));
      } catch (err) {
        throw new RazorpayApiError("Razorpay order payments fetch failed", { cause: err });
      }
    },
  };
}

/** Process-wide client. Tests inject a double via setRazorpayClientForTests. */
export function getRazorpayClient(): RazorpayOrdersClient {
  if (override) {
    return override;
  }
  if (!cached) {
    cached = createSdkClient();
  }
  return cached;
}
