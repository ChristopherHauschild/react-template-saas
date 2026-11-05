/**
 * The HTTP side of a CSV download: what an export route answers, for a
 * complete file and for every way an export can fail.
 *
 * A download is all or nothing. A file is only ever answered with the whole,
 * already-built body (and its exact `Content-Length`), never streamed while
 * records are still being read — so an export that fails part-way cannot leave
 * a truncated file in the user's downloads that looks complete.
 *
 * A failure answers with a non-2xx status, a message the user can read, and a
 * machine code in `X-Export-Error`; it carries no CSV media type, no
 * attachment header and no CSV content, so neither a browser nor a script can
 * mistake it for a file. The message is plain text — or, when the request
 * accepts `application/json` (the exports page does, to show errors beside the
 * fields), `{ "error": { code, message, fields? } }`.
 *
 * Both kinds are private to the signed-in user: never stored by a cache.
 */
import { CSV_CONTENT_TYPE } from "./csv";

/** Machine-readable reason of a failed export (`X-Export-Error`). */
export type CsvDownloadErrorCode =
  /** The date range in the request is not valid; fix the dates. */
  | "invalid_range"
  /** More records than one export may hold; choose a shorter range. */
  | "too_large"
  /** The user's billing records point at more than one account; support must resolve it. */
  | "ambiguous"
  /** Too many exports in a short time; wait `retryAfterSeconds`. */
  | "rate_limited"
  /** The records could not all be read; try again later. */
  | "unavailable"
  /** Something unexpected failed; try again later. */
  | "internal_error";

export const CSV_DOWNLOAD_ERROR_CODES: readonly CsvDownloadErrorCode[] = [
  "invalid_range",
  "too_large",
  "ambiguous",
  "rate_limited",
  "unavailable",
  "internal_error",
];

export const CSV_DOWNLOAD_ERROR_STATUS: Record<CsvDownloadErrorCode, number> = {
  invalid_range: 400,
  ambiguous: 409,
  too_large: 422,
  rate_limited: 429,
  internal_error: 500,
  unavailable: 503,
};

export type CsvDownload =
  /** The complete file. Only ever built from a complete collection. */
  | {
      ok: true;
      fileName: string;
      body: string;
      /** Records in the file (header excluded), sent as `X-Export-Row-Count`. */
      rowCount: number;
    }
  | {
      ok: false;
      code: CsvDownloadErrorCode;
      /** One sentence for the user. */
      message: string;
      /** For `invalid_range`: a message per offending field (`from`, `to`, `range`). */
      fields?: Partial<Record<string, string>>;
      /** For `rate_limited`: whole seconds until an export is allowed again (≥ 1). */
      retryAfterSeconds?: number;
    };

export const CSV_DOWNLOAD_ERROR_HEADER = "X-Export-Error";
export const CSV_DOWNLOAD_ROW_COUNT_HEADER = "X-Export-Row-Count";

/** The JSON body of a failed export, for a request that accepts JSON. */
export type CsvDownloadErrorBody = {
  error: {
    code: CsvDownloadErrorCode;
    message: string;
    fields?: Record<string, string>;
    retryAfterSeconds?: number;
  };
};

/** Whether a request's `Accept` header asks for JSON failures. */
export function wantsJsonErrors(accept: string | null): boolean {
  return (accept ?? "")
    .split(",")
    .some((type) => type.split(";")[0].trim().toLowerCase() === "application/json");
}

const FIELD_LABELS: Record<string, string> = {
  from: "From",
  to: "To",
  range: "Dates",
};

/** Headers every export response carries. */
const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

/** The file name as a `Content-Disposition` parameter; only plain ASCII names are accepted. */
function attachment(fileName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.csv$/.test(fileName)) {
    throw new Error("csv download: unsafe file name");
  }

  return `attachment; filename="${fileName}"`;
}

export type CsvDownloadResponseOptions = {
  /** Answer failures as JSON (see `wantsJsonErrors`); plain text otherwise. */
  json?: boolean;
};

/** The response for an export outcome. */
export function csvDownloadResponse(
  download: CsvDownload,
  options: CsvDownloadResponseOptions = {},
): Response {
  if (download.ok) {
    if (!Number.isSafeInteger(download.rowCount) || download.rowCount < 0) {
      throw new Error("csv download: invalid row count");
    }

    const bytes = new TextEncoder().encode(download.body);

    return new Response(bytes, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": CSV_CONTENT_TYPE,
        "Content-Disposition": attachment(download.fileName),
        "Content-Length": String(bytes.byteLength),
        [CSV_DOWNLOAD_ROW_COUNT_HEADER]: String(download.rowCount),
      },
    });
  }

  const status = CSV_DOWNLOAD_ERROR_STATUS[download.code];

  // `Retry-After` (RFC 9110) for a 429, so any client — not only the page —
  // knows when to come back. Required for `rate_limited`, meaningless otherwise.
  let retryAfter: number | undefined;
  if (download.code === "rate_limited") {
    retryAfter = download.retryAfterSeconds;
    if (retryAfter === undefined || !Number.isSafeInteger(retryAfter) || retryAfter < 1) {
      throw new Error(
        "csv download: a rate-limited answer needs a positive retryAfterSeconds",
      );
    }
  }
  const retryHeaders: Record<string, string> =
    retryAfter === undefined ? {} : { "Retry-After": String(retryAfter) };
  const fields = Object.fromEntries(
    Object.entries(download.fields ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  if (options.json) {
    const body: CsvDownloadErrorBody = {
      error: {
        code: download.code,
        message: download.message,
        ...(Object.keys(fields).length > 0 && { fields }),
        ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
      },
    };

    return new Response(JSON.stringify(body), {
      status,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        [CSV_DOWNLOAD_ERROR_HEADER]: download.code,
        ...retryHeaders,
      },
    });
  }

  const lines = [
    download.message,
    ...Object.entries(fields).map(
      ([field, message]) => `${FIELD_LABELS[field] ?? field}: ${message}`,
    ),
  ];

  return new Response(lines.join("\n") + "\n", {
    status,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      [CSV_DOWNLOAD_ERROR_HEADER]: download.code,
      ...retryHeaders,
    },
  });
}

/** What a route answers when preparing the download threw (it should not; see the services). */
export const INTERNAL_ERROR_DOWNLOAD: CsvDownload = {
  ok: false,
  code: "internal_error",
  message:
    "Something went wrong while preparing your export. Please try again in a moment; if this keeps happening, contact support.",
};
