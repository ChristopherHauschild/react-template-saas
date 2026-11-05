/**
 * Classification of failures around the Stripe Customer Portal. Duck-typed on
 * the fields stripe-node puts on its errors (`type`, `code`, `param`,
 * `statusCode`, `requestId`) so it works on real `Stripe.errors.*` instances
 * and on plain objects alike, and does not need the SDK to be constructed.
 */

/** Stripe customer ids are `cus_` followed by alphanumerics. */
const STRIPE_CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;

export function isStripeCustomerId(value: unknown): value is string {
  return typeof value === "string" && STRIPE_CUSTOMER_ID.test(value);
}

type StripeLikeError = {
  type?: unknown;
  code?: unknown;
  param?: unknown;
  statusCode?: unknown;
  requestId?: unknown;
};

function asStripeLike(error: unknown): StripeLikeError | null {
  return error !== null && typeof error === "object" ? (error as StripeLikeError) : null;
}

/**
 * Stripe does not know the customer we asked for: deleted in the Dashboard, or
 * an id from the other mode (test/live) than the API key. Not transient — the
 * user needs support, not a retry.
 */
export function isMissingCustomerError(error: unknown): boolean {
  const e = asStripeLike(error);

  return (
    e !== null &&
    e.type === "StripeInvalidRequestError" &&
    e.code === "resource_missing" &&
    e.param === "customer"
  );
}

/**
 * What may be logged about a portal failure: the error's class/type and, for
 * Stripe errors, the stable code, HTTP status and request id (for Stripe's
 * support). Never the message — it can echo request parameters.
 */
export function summarizePortalErrorForLog(error: unknown): {
  name: string;
  type?: string;
  code?: string;
  statusCode?: number;
  requestId?: string;
} {
  const e = asStripeLike(error);
  const name = error instanceof Error ? error.name : typeof error;

  if (e === null) return { name };

  return {
    name,
    type: typeof e.type === "string" ? e.type : undefined,
    code: typeof e.code === "string" ? e.code : undefined,
    statusCode: typeof e.statusCode === "number" ? e.statusCode : undefined,
    requestId: typeof e.requestId === "string" ? e.requestId : undefined,
  };
}

/**
 * A portal session is only usable if Stripe returned a secure URL for the
 * customer we asked about. Anything else is refused rather than followed: the
 * user would otherwise be redirected by data we did not verify.
 */
export function isUsablePortalSession(
  session: unknown,
  expectedCustomer: string,
): session is { url: string; customer: string } {
  if (session === null || typeof session !== "object") return false;

  const { url, customer } = session as { url?: unknown; customer?: unknown };

  if (customer !== expectedCustomer) return false;
  if (typeof url !== "string") return false;

  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
