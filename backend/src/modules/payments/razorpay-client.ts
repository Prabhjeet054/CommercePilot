import Razorpay from "razorpay";
import { loadEnv } from "../../config/env";

/** Official INR minimum from Razorpay Orders API: 100 paise (₹1.00). */
export const MIN_ORDER_AMOUNT_PAISE = 100;

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

export type RazorpayOrdersClient = {
  createOrder: (input: RazorpayOrderCreateInput) => Promise<RazorpayCreatedOrder>;
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

export function getRazorpayKeyId(): string {
  const keyId = loadEnv().RAZORPAY_KEY_ID?.trim() ?? "";
  if (!keyId) {
    throw new RazorpayConfigError("RAZORPAY_KEY_ID is not configured");
  }
  return keyId;
}

function createSdkClient(): RazorpayOrdersClient {
  const env = loadEnv();
  if (env.NODE_ENV === "test") {
    throw new RazorpayConfigError("Razorpay client must be injected in tests (no live Orders API calls)");
  }
  const key_id = env.RAZORPAY_KEY_ID?.trim() ?? "";
  const key_secret = env.RAZORPAY_KEY_SECRET?.trim() ?? "";
  if (!key_id || !key_secret) {
    throw new RazorpayConfigError("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required");
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
