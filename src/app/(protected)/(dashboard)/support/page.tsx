import { Suspense } from "react";

import { SupportRequestForm } from "@/features/support/components/support-request-form";
import { SupportRequestHistorySection } from "@/features/support/components/support-request-history-section";
import { SupportRequestHistorySkeleton } from "@/features/support/components/support-request-history-skeleton";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";

/**
 * Contact support, and the requests already sent.
 *
 * The form needs no data and renders at once; the history reads the user's
 * requests and streams in behind a skeleton, so a slow or failing read never
 * holds up (or takes down) the form. Filing a request revalidates this route:
 * the history section re-renders with the new request at the top.
 *
 * The user's id is the one thing the page reads (the same cached lookup the
 * (protected) layout's guard made). It names the account the page belongs
 * to: the form keys its unsent draft by it (a draft is only ever put back for
 * its author), and every action the page sends carries it, so the server can
 * refuse to act for a different account than the one the page shows.
 */
export default async function SupportPage() {
  const user = await requireAuth();

  return (
    // Forms read best at a moderate width; the cards stay full-width below it.
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="text-2xl font-bold">Support</h2>

        <p className="text-muted-foreground text-sm">
          Questions about your account or billing, or something not working as expected?
          Send us a request.
        </p>
      </div>

      {/* Keyed by the account: if the page is ever re-rendered for a different
          one (the session changed hands while it was open), the form starts
          fresh instead of handing the previous account's text to the new one. */}
      <SupportRequestForm key={user.id} ownerId={user.id} />

      <Suspense fallback={<SupportRequestHistorySkeleton />}>
        <SupportRequestHistorySection />
      </Suspense>
    </div>
  );
}
