import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CsvDownloadRequestResult,
  fileNameFromContentDisposition,
  requestCsvDownload,
  saveCsvFile,
} from "./csv-download-client";

const CSV = "\uFEFFDate (UTC),Invoice number\r\n2026-03-01,ABCD-0001\r\n";

const csvResponse = (headers: Record<string, string> = {}, body = CSV, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="invoices-2026-04-05.csv"',
      "x-export-row-count": "1",
      ...headers,
    },
  });

const jsonFailure = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const request = (
  response: Response | (() => Promise<Response>),
  signal?: AbortSignal,
) => {
  const fetch = vi.fn(async () =>
    typeof response === "function" ? response() : response,
  );
  return {
    fetch,
    result: requestCsvDownload("/billing/export/invoices?from=2026-03-01", {
      fetch: fetch as unknown as typeof globalThis.fetch,
      signal,
    }),
  };
};

describe("requestCsvDownload – the request", () => {
  it("asks for JSON failures, does not follow redirects, sends cookies, bypasses caches", async () => {
    const controller = new AbortController();
    const { fetch, result } = request(csvResponse(), controller.signal);
    await result;

    expect(fetch).toHaveBeenCalledWith("/billing/export/invoices?from=2026-03-01", {
      method: "GET",
      headers: { Accept: "application/json, text/csv;q=0.9" },
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
  });
});

describe("requestCsvDownload – a file", () => {
  it("answers the complete file with its name and row count", async () => {
    const result = await request(csvResponse()).result;

    expect(result).toMatchObject({
      kind: "file",
      fileName: "invoices-2026-04-05.csv",
      rowCount: 1,
    });
    const blob = (result as Extract<CsvDownloadRequestResult, { kind: "file" }>).blob;
    expect(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer()),
    ).toBe(CSV);
  });

  it.each([
    [{ "x-export-row-count": "" }],
    [{ "x-export-row-count": "-1" }],
    [{ "x-export-row-count": "12abc" }],
  ])("leaves the row count unknown when the header is unusable (%j)", async (headers) => {
    expect(await request(csvResponse(headers)).result).toMatchObject({
      kind: "file",
      rowCount: null,
    });
  });

  it.each([
    [
      "an HTML page (a followed redirect to /login)",
      { "content-type": "text/html; charset=utf-8" },
    ],
    ["JSON", { "content-type": "application/json" }],
    ["no attachment header", { "content-disposition": "" }],
    ["an inline disposition", { "content-disposition": 'inline; filename="a.csv"' }],
    [
      "a path in the file name",
      { "content-disposition": 'attachment; filename="../a.csv"' },
    ],
    ["another extension", { "content-disposition": 'attachment; filename="a.html"' }],
  ])("does not take a 200 with %s for a file", async (_label, headers) => {
    expect(await request(csvResponse(headers)).result).toEqual({
      kind: "unexpected",
      status: 200,
    });
  });

  it("does not take another 2xx for a file", async () => {
    expect(await request(csvResponse({}, CSV, 206)).result).toEqual({
      kind: "unexpected",
      status: 206,
    });
  });
});

describe("requestCsvDownload – failures the route explains", () => {
  it("answers the code, message and field messages", async () => {
    const result = await request(
      jsonFailure(400, {
        error: {
          code: "invalid_range",
          message: "Check the dates of your export.",
          fields: { from: "That day does not exist.", to: 42, range: "" },
        },
      }),
    ).result;

    expect(result).toEqual({
      kind: "rejected",
      code: "invalid_range",
      message: "Check the dates of your export.",
      fields: { from: "That day does not exist." },
    });
  });

  it.each([
    ["ambiguous", 409],
    ["too_large", 422],
    ["internal_error", 500],
    ["unavailable", 503],
  ])("%s (%i)", async (code, status) => {
    expect(
      await request(jsonFailure(status, { error: { code, message: "Explained." } }))
        .result,
    ).toEqual({ kind: "rejected", code, message: "Explained.", fields: {} });
  });

  it.each([
    ["an unknown code", { error: { code: "teapot", message: "x" } }],
    ["no message", { error: { code: "unavailable" } }],
    ["a blank message", { error: { code: "unavailable", message: "  " } }],
    [
      "fields that are not an object",
      { error: { code: "invalid_range", message: "x", fields: "from" } },
    ],
    ["another shape", { message: "x" }],
    ["null", null],
  ])("treats a JSON body with %s as unexpected", async (_label, body) => {
    expect(await request(jsonFailure(503, body)).result).toEqual({
      kind: "unexpected",
      status: 503,
    });
  });

  it("treats an error page that is not JSON as unexpected, keeping the status", async () => {
    const html = new Response("<!doctype html><h1>502 Bad Gateway</h1>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });

    expect(await request(html).result).toEqual({ kind: "unexpected", status: 502 });
  });
});

describe("requestCsvDownload – everything else", () => {
  it("recognises the sign-in redirect it did not follow", async () => {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
    };

    expect(await request(opaque as unknown as Response).result).toEqual({
      kind: "signed_out",
    });
  });

  it.each([302, 303, 307, 401])("treats a %i as a signed-out session", async (status) => {
    const response = new Response(null, { status, headers: { location: "/login" } });

    expect(await request(response).result).toEqual({ kind: "signed_out" });
  });

  it("answers `network` when the server cannot be reached", async () => {
    const { result } = request(() => Promise.reject(new TypeError("Failed to fetch")));

    expect(await result).toEqual({ kind: "network" });
  });

  it("answers `aborted` when the request is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = request(
      () => Promise.reject(new DOMException("The user aborted a request.", "AbortError")),
      controller.signal,
    );

    expect(await result).toEqual({ kind: "aborted" });
  });

  it("answers `network` when the connection drops while the file is read", async () => {
    const response = csvResponse();
    vi.spyOn(response, "blob").mockRejectedValue(new TypeError("terminated"));

    expect(await request(response).result).toEqual({ kind: "network" });
  });

  it("answers `aborted` when cancelled while the file is read", async () => {
    const controller = new AbortController();
    const response = csvResponse();
    vi.spyOn(response, "blob").mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    expect(await request(response, controller.signal).result).toEqual({
      kind: "aborted",
    });
  });

  it("never throws", async () => {
    const { result } = request(() => {
      throw new Error("synchronous failure inside fetch");
    });

    await expect(result).resolves.toEqual({ kind: "network" });
  });
});

describe("fileNameFromContentDisposition", () => {
  it.each([
    ['attachment; filename="invoices-2026-04-05.csv"', "invoices-2026-04-05.csv"],
    ['attachment;filename="a.csv"', "a.csv"],
    ['Attachment; filename="A_b.1.csv"', "A_b.1.csv"],
    ['attachment; filename="a.txt"', null],
    ['attachment; filename=".csv"', null],
    ['attachment; filename="../../a.csv"', null],
    ['attachment; filename="a b.csv"', null],
    ['attachment; filename="caf\u00E9.csv"', null],
    ["attachment; filename=a.csv", null],
    ['inline; filename="a.csv"', null],
    ["", null],
    [null, null],
  ])("%j → %j", (value, expected) => {
    expect(fileNameFromContentDisposition(value)).toBe(expected);
  });
});

describe("saveCsvFile", () => {
  let click: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:https://app.example.com/1234");
    URL.revokeObjectURL = vi.fn();
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clicks a temporary link to the file under its name, then cleans up", () => {
    const blob = new Blob([CSV], { type: "text/csv" });
    let attachedWhenClicked = false;
    click.mockImplementation(function (this: HTMLAnchorElement) {
      attachedWhenClicked = document.body.contains(this);
    });

    saveCsvFile(blob, "invoices-2026-04-05.csv");

    const clicked = click.mock.contexts[0] as HTMLAnchorElement;
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked.download).toBe("invoices-2026-04-05.csv");
    expect(clicked.href).toBe("blob:https://app.example.com/1234");
    expect(attachedWhenClicked).toBe(true);
    expect(document.body.contains(clicked)).toBe(false);

    // Released later, not during the click.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://app.example.com/1234");
  });
});

describe("requestCsvDownload – rate limited", () => {
  const limited = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 429,
      headers: { "content-type": "application/json", ...headers },
    });

  it("answers the wait the route gave", async () => {
    expect(
      await request(
        limited(
          {
            error: {
              code: "rate_limited",
              message: "Please wait.",
              retryAfterSeconds: 42,
            },
          },
          { "retry-after": "42" },
        ),
      ).result,
    ).toEqual({
      kind: "rejected",
      code: "rate_limited",
      message: "Please wait.",
      fields: {},
      retryAfterSeconds: 42,
    });
  });

  it("falls back to the Retry-After header when the body has no wait", async () => {
    expect(
      await request(
        limited(
          { error: { code: "rate_limited", message: "Please wait." } },
          { "retry-after": " 90 " },
        ),
      ).result,
    ).toMatchObject({ kind: "rejected", retryAfterSeconds: 90 });
  });

  it.each([
    [{ retryAfterSeconds: 0 }, {}],
    [{ retryAfterSeconds: -3 }, {}],
    [{ retryAfterSeconds: 1.5 }, {}],
    [{ retryAfterSeconds: "42" }, {}],
    [{}, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }], // the HTTP-date form: not used by the route
    [{}, {}],
  ])("leaves the wait out when it is unusable (%j, %j)", async (extra, headers) => {
    const result = await request(
      limited(
        { error: { code: "rate_limited", message: "Please wait.", ...extra } },
        headers,
      ),
    ).result;

    expect(result).toMatchObject({ kind: "rejected", code: "rate_limited" });
    expect(result).not.toHaveProperty("retryAfterSeconds");
  });
});
