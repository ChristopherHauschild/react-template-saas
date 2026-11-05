"use client";

import { ROUTES } from "@/config/routes";
import {
  CSV_EXPORT_COMMON_COPY,
  CsvExportCard,
  type CsvExportCopy,
  downloadedCountText,
} from "@/shared/components/csv-export-card";

import { ACCOUNT_ACTIVITY_DOWNLOAD_PATH } from "../services/account-activity-download-path";

/** What the status line says once the activity file has been handed to the browser. */
export function downloadedActivityText(
  fileName: string,
  rowCount: number | null,
): string {
  return downloadedCountText(fileName, rowCount, {
    one: "entry",
    other: "entries",
    none: "There is no account activity in this period.",
  });
}

export const ACCOUNT_ACTIVITY_EXPORT_COPY = {
  ...CSV_EXPORT_COMMON_COPY,
  title: "Account activity",
  description:
    "A CSV file of the changes made to your account — display name, email address, password and sessions — with the time of each. Entries this version of the app can't describe are listed as such, never left out.",
  formLabel: "Export account activity",
  datesHint:
    "Dates are UTC days and both are included. Leave them empty to export all of your account activity.",
  progress:
    "Preparing your account activity export. This can take a little while if your history is long.",
  downloaded: downloadedActivityText,
} satisfies CsvExportCopy;

/**
 * The account activity export on the exports page, backed by
 * `GET /settings/export/activity`. All behaviour — date checks, loading,
 * cancelling, errors in place, saving the file — is the shared
 * `CsvExportCard`'s, exactly as for invoices; this only says what is
 * exported and where from.
 */
export function AccountActivityExportCard() {
  return (
    <CsvExportCard
      path={ACCOUNT_ACTIVITY_DOWNLOAD_PATH}
      copy={ACCOUNT_ACTIVITY_EXPORT_COPY}
      idPrefix="activity-export"
      exportName="account-activity"
      signInHref={ROUTES.login}
    />
  );
}
