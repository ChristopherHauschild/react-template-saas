import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";

import { SUPPORT_HISTORY_COPY as COPY } from "../services/support-request-history";

/** Placeholder rows while the first page loads; shaped like real items. */
const ROWS = 3;

/**
 * What the history shows while its first page is being read (the Suspense
 * fallback on the support page). The form above is already usable; only this
 * card waits. The heading is real, so the page's outline does not jump, and
 * one live region tells screen readers the list is on its way; the grey bars
 * are decorative.
 */
export function SupportRequestHistorySkeleton() {
  return (
    <Card
      data-support-section="history"
      data-history-state="loading"
      aria-busy="true"
      aria-labelledby="support-history-loading-title"
      role="region"
    >
      <CardHeader>
        <CardTitle asChild>
          <h3 id="support-history-loading-title">{COPY.title}</h3>
        </CardTitle>
        <CardDescription>{COPY.description.loading}</CardDescription>
      </CardHeader>

      <CardContent>
        <p role="status" className="sr-only">
          {COPY.loadingAnnouncement}
        </p>
        <ul aria-hidden="true" className="divide-y divide-border">
          {Array.from({ length: ROWS }, (_, index) => (
            <li key={index} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
                <div className="h-4 w-12 animate-pulse rounded-full bg-muted" />
              </div>
              <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
