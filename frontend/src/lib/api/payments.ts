import type { AuthFetch } from "@/lib/api/purchase-intents";

export type CreateOrderResponse = {
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
};

export type VerifyPaymentInput = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

export type VerifyPaymentResponse = {
  verified?: boolean;
  orderState?: string;
  status?: string;
  error?: string;
  reasonCode?: string;
  message?: string;
};

export class PaymentsApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reasonCode?: string;
  readonly orderState?: string;

  constructor(
    code: string,
    message: string,
    status: number,
    extras?: { reasonCode?: string; orderState?: string },
  ) {
    super(message);
    this.name = "PaymentsApiError";
    this.code = code;
    this.status = status;
    this.reasonCode = extras?.reasonCode;
    this.orderState = extras?.orderState;
  }
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function createPaymentOrder(
  authFetch: AuthFetch,
  purchaseIntentId: string,
): Promise<CreateOrderResponse> {
  const response = await authFetch("/payments/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purchaseIntentId }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "CREATE_ORDER_FAILED";
    throw new PaymentsApiError(code, "Could not start payment. Please try again.", response.status);
  }
  if (
    typeof body.razorpayOrderId !== "string" ||
    typeof body.amount !== "number" ||
    typeof body.currency !== "string" ||
    typeof body.keyId !== "string"
  ) {
    throw new PaymentsApiError("INVALID_CREATE_ORDER", "Payment order response was incomplete.", 500);
  }
  return {
    razorpayOrderId: body.razorpayOrderId,
    amount: body.amount,
    currency: body.currency,
    keyId: body.keyId,
  };
}

/** Phase 17 — server HMAC verification of the Checkout handler payload. */
export async function verifyPayment(
  authFetch: AuthFetch,
  input: VerifyPaymentInput,
): Promise<VerifyPaymentResponse> {
  const response = await authFetch("/payments/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await readBody(response);

  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "VERIFY_FAILED";
    const message =
      typeof body.message === "string"
        ? body.message
        : code === "SIGNATURE_MISMATCH"
          ? "Payment signature could not be verified."
          : "Could not verify that payment.";
    throw new PaymentsApiError(code, message, response.status, {
      reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : undefined,
      orderState: typeof body.orderState === "string" ? body.orderState : undefined,
    });
  }

  return {
    verified: body.verified === true,
    orderState: typeof body.orderState === "string" ? body.orderState : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    message: typeof body.message === "string" ? body.message : undefined,
  };
}
