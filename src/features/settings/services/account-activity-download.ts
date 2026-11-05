import "server-only";

import { csvFileNameForRange } from "@/shared/utils/csv";
import type { CsvDownload } from "@/shared/utils/csv-download";
import { dateRangeParamsFrom, parseDateRange } from "@/shared/utils/date-range";

import {
  ACCOUNT_ACTIVITY_EXPORT_FILE_BASE,
  buildAccountActivityExportCsv,
} from "./account-activity-export";
import {
  ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES,
  collectAccountActivityForExport,
} from "./collect-account-activity-export";

export { ACCOUNT_ACTIVITY_DOWNLOAD_PATH } from "./account-activity-download-path";

export const ACCOUNT_ACTIVITY_DOWNLOAD_COPY = {
  invalidRange: "Check the dates of your export.",
  tooLarge: `Your account activity in this period has more than ${ACCOUNT_ACTIVITY_EXPORT_MAX_ENTRIES.toLocaleString("en-US")} entries, too many for one file. Choose a shorter date range and try again.`,
  unavailable:
    "We couldn't export your account activity right now. Please try again in a moment; if this keeps happening, contact support.",
} as const;

export type PrepareAccountActivityDownloadOptions = {
  /** The moment the export is made, for the file name (tests). */
  now?: Date;
};

/**
 * Prepares the signed-in user's account activity download from the request's
 * query string: the date range (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, both
 * optional, UTC days) is parsed and validated HERE, on the server — nothing
 * the client sends is trusted — then the whole history in that range is
 * collected (`collectAccountActivityForExport`: as the user, under RLS, all or
 * nothing) and only then turned into a file.
 *
 * `userId` must come from the verified session (`requireAuth()`); nothing in
 * `searchParams` names a user. Anything short of a complete collection is a
 * failure outcome with no file: an invalid range (nothing is read), a history
 * too long for one file, or any read that failed.
 */
export async function prepareAccountActivityDownload(
  userId: string,
  searchParams: URLSearchParams,
  options: PrepareAccountActivityDownloadOptions = {},
): Promise<CsvDownload> {
  const parsed = parseDateRange(dateRangeParamsFrom(searchParams));

  if (!parsed.ok) {
    return {
      ok: false,
      code: "invalid_range",
      message: ACCOUNT_ACTIVITY_DOWNLOAD_COPY.invalidRange,
      fields: parsed.errors,
    };
  }

  const collection = await collectAccountActivityForExport(userId, {
    range: parsed.range,
  });

  if (!collection.ok) {
    // The collector has logged the cause.
    switch (collection.reason) {
      case "invalid_range":
        return {
          ok: false,
          code: "invalid_range",
          message: ACCOUNT_ACTIVITY_DOWNLOAD_COPY.invalidRange,
        };
      case "too_large":
        return {
          ok: false,
          code: "too_large",
          message: ACCOUNT_ACTIVITY_DOWNLOAD_COPY.tooLarge,
        };
      default:
        return {
          ok: false,
          code: "unavailable",
          message: ACCOUNT_ACTIVITY_DOWNLOAD_COPY.unavailable,
        };
    }
  }

  return {
    ok: true,
    fileName: csvFileNameForRange(
      ACCOUNT_ACTIVITY_EXPORT_FILE_BASE,
      parsed.range,
      options.now ?? new Date(),
    ),
    body: buildAccountActivityExportCsv(collection.entries),
    rowCount: collection.entries.length,
  };
}
