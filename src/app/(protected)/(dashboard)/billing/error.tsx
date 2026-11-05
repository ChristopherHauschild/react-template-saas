"use client";

import { useEffect } from "react";

/**
 * Error boundary for the billing page. Reached only for unexpected failures —
 * an exception while loading the page, or a Stripe API error while opening the
 * Customer Portal. Expected problems (no billing account, records unreadable)
 * are shown inline instead. Renders inside the dashboard shell, so it is a card
 * rather than a full-screen page.
 */
export default function BillingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[billing] unexpected error", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto w-full max-w-md rounded-2xl border border-border bg-card/80 p-6 text-center backdrop-blur-sm"
    >
      <h2 className="text-xl font-semibold text-foreground">
        Billing is temporarily unavailable
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Please try again in a moment; if the problem persists, contact support
        {error.digest ? ` and quote reference ${error.digest}` : ""}.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
        <a
          href="/dashboard"
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          Back to dashboard
        </a>
      </div>
    </div>
  );
}
