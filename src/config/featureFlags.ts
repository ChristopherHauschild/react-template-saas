/**
 * Feature availability switches.
 *
 * Navigation derives whether a destination is reachable from these flags, so a
 * route that doesn't exist yet is shown as "coming soon" instead of a link to a 404.
 * Flip a flag to `true` once the corresponding page has been implemented.
 */
export const featureFlags = {
  /** `/billing` page – subscription status and the Stripe Customer Portal. */
  billing: true,
  /** `/settings` page – account profile (display name); email/password to follow. */
  settings: true,
  /** `/exports` page – CSV downloads of the user's data (invoices first). */
  exports: true,
  /** `/support` page – submit and review own support requests. */
  support: true,
} as const;

export type FeatureFlags = { [K in keyof typeof featureFlags]: boolean };
