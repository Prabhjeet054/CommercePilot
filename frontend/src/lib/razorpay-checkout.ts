/** Official Standard Checkout script (Razorpay CDN — do not self-host). */
export const RAZORPAY_CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

/** Reserved money-moving accent: CSS `--primary` hsl(43 96% 56%). */
export const CHECKOUT_THEME_COLOR = "#FABC23";

export type RazorpayCheckoutSuccess = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

export type RazorpayCheckoutPrefill = {
  name?: string;
  email?: string;
  contact?: string;
};

export type RazorpayCheckoutOptions = {
  key: string;
  amount: number | string;
  currency: string;
  name?: string;
  description?: string;
  order_id: string;
  handler: (response: RazorpayCheckoutSuccess) => void;
  prefill?: RazorpayCheckoutPrefill;
  theme?: { color?: string };
  modal?: {
    ondismiss?: () => void;
    confirm_close?: boolean;
    escape?: boolean;
    backdropclose?: boolean;
    animation?: boolean;
  };
  retry?: { enabled?: boolean; max_count?: number };
};

type RazorpayConstructor = new (options: RazorpayCheckoutOptions) => { open: () => void };

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let scriptPromise: Promise<void> | null = null;

export function loadRazorpayCheckoutScript(
  src: string = RAZORPAY_CHECKOUT_SCRIPT_URL,
): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Razorpay Checkout requires a browser"));
  }
  if (window.Razorpay) {
    return Promise.resolve();
  }
  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Razorpay Checkout")), {
        once: true,
      });
      if (window.Razorpay) {
        resolve();
      }
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Failed to load Razorpay Checkout"));
    };
    document.body.appendChild(script);
  });

  return scriptPromise;
}

/**
 * Loads checkout.js from Razorpay's CDN (if needed) and opens Standard Checkout.
 * Call from a user gesture when possible; PaymentScreen also offers an explicit Pay Now.
 */
export async function openCheckout(options: RazorpayCheckoutOptions): Promise<void> {
  await loadRazorpayCheckoutScript();
  if (!window.Razorpay) {
    throw new Error("Razorpay Checkout is not available");
  }
  const rzp = new window.Razorpay(options);
  rzp.open();
}
