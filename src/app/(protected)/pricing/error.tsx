"use client";

import { useEffect } from "react";

/**
 * Error boundary for the pricing page. Reached only for unexpected failures (e.g.
 * Stripe API errors while starting a checkout); expected problems are shown inline
 * on the plan card instead. Gives the user a way forward rather than a blank page.
 */
export default function PricingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[pricing] unexpected error", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-2xl border border-border bg-card/80 p-6 text-center backdrop-blur-sm"
      >
        <h1 className="text-xl font-semibold text-foreground">
          We couldn&apos;t start your checkout
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing was charged. Please try again in a moment; if the problem persists,
          contact support
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
    </main>
  );
}
