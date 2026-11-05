/**
 * The browser side of a CSV download (see `csv-download.ts` for the server
 * side): request an export, tell every possible answer apart, and hand a
 * finished file to the browser's downloads.
 *
 * The request is a `fetch` rather than a navigation, so that nothing but a
 * complete file ever reaches the user's downloads and every failure can be
 * shown on the page:
 * - `Accept: application/json` asks the route for failures as JSON, with a
 *   message per field;
 * - `redirect: "manual"`: an expired session makes the route redirect to
 *   /login. Followed, that would answer the login page's HTML with a 200 —
 *   which must not be saved as a CSV. Not followed, it is recognisable;
 * - a success is only accepted as a file if it really is one: status 200, the
 *   CSV media type and an attachment with a safe file name.
 */
import { CSV_DOWNLOAD_ERROR_CODES, type CsvDownloadErrorCode } from "./csv-download";

export type CsvDownloadRequestResult =
  /** The complete file. */
  | { kind: "file"; blob: Blob; fileName: string; rowCount: number | null }
  /** The server refused or failed the export and said why. */
  | {
      kind: "rejected";
      code: CsvDownloadErrorCode;
      message: string;
      /** Messages per field name, when the server gave any. */
      fields: Record<string, string>;
      /** For `rate_limited`: whole seconds until the route accepts another export. */
      retryAfterSeconds?: number;
    }
  /** The session has ended; the user must sign in again. */
  | { kind: "signed_out" }
  /** The server could not be reached (offline, DNS, connection reset). */
  | { kind: "network" }
  /** The request was cancelled through its signal. */
  | { kind: "aborted" }
  /** An answer that is neither a file nor one of the route's failures. */
  | { kind: "unexpected"; status: number };

export type RequestCsvDownloadOptions = {
  signal?: AbortSignal;
  /** Injectable for tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
};

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.csv$/;

/**
 * The file name of an `attachment; filename="…"` header — only the plain
 * ASCII `.csv` names the export routes produce; `null` for anything else, so
 * nothing the header says can pick an odd name or path for the saved file.
 */
export function fileNameFromContentDisposition(value: string | null): string | null {
  const match = /^attachment;\s*filename="([^"]*)"$/i.exec(value?.trim() ?? "");

  return match && SAFE_FILE_NAME.test(match[1]) ? match[1] : null;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isErrorCode(value: unknown): value is CsvDownloadErrorCode {
  return (
    typeof value === "string" &&
    (CSV_DOWNLOAD_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** A positive whole number of seconds, from the JSON field or a `Retry-After: <seconds>` header. */
function positiveSeconds(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;

  return Number.isSafeInteger(seconds) && seconds >= 1 ? seconds : undefined;
}

/** The `{ error: { code, message, fields?, retryAfterSeconds? } }` body of a failure, or `null` if it is not one. */
function readFailure(
  body: unknown,
  retryAfterHeader: string | null,
): Extract<CsvDownloadRequestResult, { kind: "rejected" }> | null {
  if (body === null || typeof body !== "object") return null;

  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;

  const { code, message, fields, retryAfterSeconds } = error as {
    code?: unknown;
    message?: unknown;
    fields?: unknown;
    retryAfterSeconds?: unknown;
  };

  if (!isErrorCode(code) || typeof message !== "string" || message.trim() === "") {
    return null;
  }

  const safeFields: Record<string, string> = {};

  if (fields !== undefined) {
    if (fields === null || typeof fields !== "object") return null;

    for (const [name, text] of Object.entries(fields)) {
      if (typeof text === "string" && text.trim() !== "") safeFields[name] = text;
    }
  }

  // The body's wait must be a number, like everything else in it; the header
  // is text by nature.
  const wait =
    (typeof retryAfterSeconds === "number"
      ? positiveSeconds(retryAfterSeconds)
      : undefined) ?? positiveSeconds(retryAfterHeader);

  return {
    kind: "rejected",
    code,
    message,
    fields: safeFields,
    ...(wait !== undefined && { retryAfterSeconds: wait }),
  };
}

/** Requests an export from a same-origin download route; never throws. */
export async function requestCsvDownload(
  url: string,
  options: RequestCsvDownloadOptions = {},
): Promise<CsvDownloadRequestResult> {
  const { signal } = options;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  let response: Response;

  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json, text/csv;q=0.9" },
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    return isAbort(error, signal) ? { kind: "aborted" } : { kind: "network" };
  }

  // The guard's redirect to /login, not followed (an "opaque redirect" has
  // status 0); a 401 would mean the same.
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400) ||
    response.status === 401
  ) {
    return { kind: "signed_out" };
  }

  try {
    if (response.ok) {
      const fileName = fileNameFromContentDisposition(
        response.headers.get("content-disposition"),
      );
      const type = (response.headers.get("content-type") ?? "").toLowerCase();

      if (response.status !== 200 || !type.startsWith("text/csv") || fileName === null) {
        return { kind: "unexpected", status: response.status };
      }

      const blob = await response.blob();
      const count = response.headers.get("x-export-row-count");
      const rowCount = count !== null && /^\d+$/.test(count) ? Number(count) : null;

      return { kind: "file", blob, fileName, rowCount };
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      // Not JSON: an error page from somewhere other than the route.
      return { kind: "unexpected", status: response.status };
    }

    return (
      readFailure(body, response.headers.get("retry-after")) ?? {
        kind: "unexpected",
        status: response.status,
      }
    );
  } catch (error) {
    // Reading the body failed: cancelled, or the connection dropped mid-way.
    return isAbort(error, signal) ? { kind: "aborted" } : { kind: "network" };
  }
}

/**
 * Hands a finished file to the browser's downloads under `fileName`, through
 * a temporary object URL. The URL is released a while later rather than at
 * once: some browsers read it only after the click has returned.
 */
export function saveCsvFile(
  blob: Blob,
  fileName: string,
  doc: Document = document,
): void {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");

  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  doc.body.append(link);

  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
