import "server-only";

import { z } from "zod";

/** Treats an empty string from a `.env` file (`KEY=`) as "not set". */
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  SUPABASE_SERVICE_ROLE_KEY: z.string(),
  /**
   * Key material for the cookies this app signs itself (e.g. the email-change
   * status flash). Optional: when unset, a purpose-specific key is derived from
   * `SUPABASE_SERVICE_ROLE_KEY` instead (see `infrastructure/auth/signed-cookie.ts`).
   * Set it in production so that signing does not depend on — or rotate with —
   * the Supabase key. Any long random string (32+ bytes) will do.
   */
  APP_SECRET: optionalString,
  /**
   * Stripe Price ids (`price_…`) for the paid plans in the catalog
   * (`src/features/billing/services/plan-catalog.ts`). Optional so that the rest
   * of the server (e.g. the webhook) keeps working when a plan is not configured;
   * an unconfigured plan is simply not purchasable.
   */
  STRIPE_PRICE_PRO: optionalString,
  STRIPE_PRICE_ENTERPRISE: optionalString,
});

export const serverEnv = serverEnvSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  APP_SECRET: process.env.APP_SECRET,
  STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
  STRIPE_PRICE_ENTERPRISE: process.env.STRIPE_PRICE_ENTERPRISE,
});
