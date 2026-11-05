import type { ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import {
  act,
  cleanup as cleanupRendered,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CsvExportCopy } from "@/shared/components/csv-export-card";
import { DATE_RANGE_ERRORS } from "@/shared/utils/date-range";

/**
 * The behaviour every export card must have — the shared `CsvExportCard`
 * behind a concrete export — as one suite, run by each card's own test file
 * with its real path, copy and ids. So "same behaviour as invoices" is not a
 * promise but a test both cards pass.
 *
 * The network is a stand-in `fetch` whose requests wait until the test answers
 * them (so the loading state can be observed) and reject on abort like a real
 * one; saving a file is observed through the temporary link's click.
 */
export type CsvExportCardSuite = {
  /** For the test names, e.g. "InvoiceExportCard". */
  name: string;
  element: () => ReactElement;
  /** The export route the card must request. */
  path: string;
  copy: CsvExportCopy;
  /** The card's id prefix (`<prefix>-from`, …). */
  idPrefix: string;
  /** Base of the file names the route answers, e.g. "invoices". */
  fileBase: string;
};

export function describeCsvExportCard(suite: CsvExportCardSuite) {
  describe(`${suite.name} (shared export behaviour)`, () => {
    // --- the network ------------------------------------------------------------

    type Pending = {
      url: string;
      init: RequestInit;
      resolve: (response: Response) => void;
      reject: (error: unknown) => void;
    };

    /** Every fetch waits here until the test answers it, so the loading state can be observed. */
    let requests: Pending[] = [];

    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const pending = { url, init, resolve, reject };
        requests.push(pending);
        // Like a real fetch: cancelling rejects with an AbortError.
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    });

    const lastRequest = () => requests[requests.length - 1];

    const csvResponse = (
      fileName = `${suite.fileBase}-2026-04-05.csv`,
      rowCount = "25",
    ) =>
      new Response("\uFEFFDate (UTC),Invoice number\r\n", {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${fileName}"`,
          "x-export-row-count": rowCount,
        },
      });

    const failure = (status: number, error: Record<string, unknown>) =>
      new Response(JSON.stringify({ error }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });

    /** Answers the last request and lets React settle. */
    const answer = async (response: Response | Error) => {
      const pending = lastRequest();
      await act(async () => {
        if (response instanceof Error) pending.reject(response);
        else pending.resolve(response);
      });
    };

    // --- the page ------------------------------------------------------------------

    let saved: { href: string; download: string }[] = [];

    beforeEach(() => {
      requests = [];
      saved = [];
      fetchMock.mockClear();
      vi.stubGlobal("fetch", fetchMock);
      URL.createObjectURL = vi.fn(() => "blob:https://app.example.com/file");
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        saved.push({ href: this.href, download: this.download });
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    const fields = () => ({
      from: screen.getByLabelText("From") as HTMLInputElement,
      to: screen.getByLabelText("To") as HTMLInputElement,
    });

    const setDates = (from: string, to: string) => {
      const { from: fromInput, to: toInput } = fields();
      fireEvent.change(fromInput, { target: { value: from } });
      fireEvent.change(toInput, { target: { value: to } });
    };

    const downloadButton = () =>
      screen.getByRole("button", { name: /download csv|preparing/i });
    const status = () => screen.getByRole("status");
    const generalError = () => document.querySelector<HTMLElement>("[data-export-error]");

    describe(`${suite.name} – the form`, () => {
      it("offers two labelled UTC date fields and a download button, with nothing to report yet", () => {
        render(suite.element());

        expect(screen.getByText(suite.copy.title)).toBeInTheDocument();
        const { from, to } = fields();
        expect(from).toHaveAttribute("type", "date");
        expect(to).toHaveAttribute("type", "date");
        expect(from).toHaveAccessibleDescription(suite.copy.datesHint);
        expect(from).not.toHaveAttribute("aria-invalid");
        expect(downloadButton()).toHaveTextContent("Download CSV");
        expect(downloadButton()).toHaveAttribute("type", "submit");
        expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(status()).toHaveTextContent("");
      });
    });

    describe(`${suite.name} – downloading`, () => {
      it("requests the whole history when no dates are set, from the export route", async () => {
        const user = userEvent.setup();
        render(suite.element());

        await user.click(downloadButton());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lastRequest().url).toBe(suite.path);
        expect(lastRequest().init).toMatchObject({
          redirect: "manual",
          headers: { Accept: "application/json, text/csv;q=0.9" },
        });
      });

      it.each([
        ["2026-03-01", "2026-03-31", "?from=2026-03-01&to=2026-03-31"],
        ["2026-03-01", "", "?from=2026-03-01"],
        ["", "2026-03-31", "?to=2026-03-31"],
        ["2026-03-15", "2026-03-15", "?from=2026-03-15&to=2026-03-15"],
      ])("sends from=%j to=%j as %s", async (from, to, query) => {
        const user = userEvent.setup();
        render(suite.element());

        setDates(from, to);
        await user.click(downloadButton());

        expect(lastRequest().url).toBe(`${suite.path}${query}`);
      });

      it("still sends the dates in browsers without URLSearchParams.size (Safari < 17)", async () => {
        const descriptor = Object.getOwnPropertyDescriptor(
          URLSearchParams.prototype,
          "size",
        );
        Object.defineProperty(URLSearchParams.prototype, "size", {
          configurable: true,
          get: () => undefined,
        });

        try {
          const user = userEvent.setup();
          render(suite.element());

          setDates("2026-03-01", "2026-03-31");
          await user.click(downloadButton());

          // Dropping the range here would silently export everything.
          expect(lastRequest().url).toBe(`${suite.path}?from=2026-03-01&to=2026-03-31`);
        } finally {
          if (descriptor)
            Object.defineProperty(URLSearchParams.prototype, "size", descriptor);
        }
      });

      it("shows that the export is being prepared, and can be cancelled, until the answer arrives", async () => {
        const user = userEvent.setup();
        render(suite.element());

        await user.click(downloadButton());

        expect(downloadButton()).toHaveTextContent(suite.copy.downloading);
        expect(downloadButton()).toHaveAttribute("aria-busy", "true");
        expect(downloadButton()).toHaveAttribute("aria-disabled", "true");
        expect(screen.getByRole("form", { name: suite.copy.formLabel })).toHaveAttribute(
          "aria-busy",
          "true",
        );
        expect(status()).toHaveTextContent(suite.copy.progress);
        expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

        await answer(csvResponse());

        expect(downloadButton()).toHaveTextContent("Download CSV");
        expect(downloadButton()).not.toHaveAttribute("aria-busy");
        expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      });

      it("saves the finished file under the server's name and says what it held", async () => {
        const user = userEvent.setup();
        render(suite.element());

        setDates("2026-03-01", "2026-03-31");
        await user.click(downloadButton());
        await answer(csvResponse(`${suite.fileBase}-2026-03-01-to-2026-03-31.csv`, "25"));

        expect(saved).toEqual([
          {
            href: "blob:https://app.example.com/file",
            download: `${suite.fileBase}-2026-03-01-to-2026-03-31.csv`,
          },
        ]);
        // The file handed to the browser is the response body, byte for byte.
        const [blob] = vi.mocked(URL.createObjectURL).mock.calls[0] as [Blob];
        expect(blob.type).toMatch(/^text\/csv/);
        expect(
          new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer()),
        ).toBe("\uFEFFDate (UTC),Invoice number\r\n");
        expect(status()).toHaveTextContent(
          suite.copy.downloaded(`${suite.fileBase}-2026-03-01-to-2026-03-31.csv`, 25),
        );
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      });

      it("says so when the period holds nothing (the file has only its header)", async () => {
        const user = userEvent.setup();
        render(suite.element());

        await user.click(downloadButton());
        await answer(csvResponse(`${suite.fileBase}-2026-04-05.csv`, "0"));

        expect(saved).toHaveLength(1);
        expect(status()).toHaveTextContent(
          suite.copy.downloaded(`${suite.fileBase}-2026-04-05.csv`, 0),
        );
      });

      it("starts only one export at a time", async () => {
        const user = userEvent.setup();
        render(suite.element());

        await user.click(downloadButton());
        await user.click(downloadButton());
        fireEvent.submit(screen.getByRole("form", { name: suite.copy.formLabel }));

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    describe(`${suite.name} – dates checked before anything is sent`, () => {
      it("refuses a start after the end beside the fields, and focuses the first", async () => {
        const user = userEvent.setup();
        render(suite.element());

        setDates("2026-04-01", "2026-03-01");
        await user.click(downloadButton());

        expect(fetchMock).not.toHaveBeenCalled();
        const { from, to } = fields();
        expect(screen.getByRole("alert")).toHaveTextContent(DATE_RANGE_ERRORS.range);
        expect(from).toHaveAttribute("aria-invalid", "true");
        expect(to).toHaveAttribute("aria-invalid", "true");
        expect(from).toHaveAccessibleDescription(
          `${suite.copy.datesHint} ${DATE_RANGE_ERRORS.range}`,
        );
        expect(from).toHaveFocus();
        expect(saved).toEqual([]);
      });

      it("clears a field's message once the field is edited", async () => {
        const user = userEvent.setup();
        render(suite.element());

        setDates("2026-04-01", "2026-03-01");
        await user.click(downloadButton());
        expect(screen.getByRole("alert")).toBeInTheDocument();

        fireEvent.change(fields().to, { target: { value: "2026-04-30" } });

        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(fields().from).not.toHaveAttribute("aria-invalid");
      });

      it("sends the corrected range once it is fixed", async () => {
        const user = userEvent.setup();
        render(suite.element());

        setDates("2026-04-01", "2026-03-01");
        await user.click(downloadButton());
        setDates("2026-03-01", "2026-04-01");
        await user.click(downloadButton());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lastRequest().url).toBe(`${suite.path}?from=2026-03-01&to=2026-04-01`);
      });
    });

    describe(`${suite.name} – failures are shown on the page, and nothing is saved`, () => {
      const submit = async () => {
        const user = userEvent.setup();
        render(suite.element());
        setDates("2026-03-01", "2026-03-31");
        await user.click(downloadButton());
        return user;
      };

      it("shows the server's field messages beside the fields", async () => {
        await submit();
        await answer(
          failure(400, {
            code: "invalid_range",
            message: "Check the dates of your export.",
            fields: { from: DATE_RANGE_ERRORS.year },
          }),
        );

        const { from, to } = fields();
        expect(from).toHaveAttribute("aria-invalid", "true");
        expect(from).toHaveAccessibleDescription(
          `${suite.copy.datesHint} ${DATE_RANGE_ERRORS.year}`,
        );
        expect(to).not.toHaveAttribute("aria-invalid");
        // The field message says it all; no second, general alert.
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(generalError()).toBeNull();
        expect(saved).toEqual([]);
      });

      it.each([
        [409, "ambiguous", "The route's message for an ambiguous account."],
        [422, "too_large", "The route's message for a history too large for one file."],
        [503, "unavailable", "The route's message for a source that could not be read."],
        [500, "internal_error", "The route's message for an unexpected failure."],
        [400, "invalid_range", "Check the dates of your export."], // without field messages
      ])(
        "%i %s: the server's message, as an alert",
        async (statusCode, code, message) => {
          await submit();
          await answer(failure(statusCode, { code, message }));

          expect(generalError()).toHaveAttribute("role", "alert");
          expect(generalError()).toHaveTextContent(message);
          expect(saved).toEqual([]);
          expect(URL.createObjectURL).not.toHaveBeenCalled();
          expect(downloadButton()).toHaveTextContent("Download CSV");
          expect(status()).toHaveTextContent("");
        },
      );

      it("explains an answer that is neither a file nor the route's error", async () => {
        await submit();
        await answer(new Response("<h1>Bad gateway</h1>", { status: 502 }));

        expect(generalError()).toHaveTextContent(suite.copy.unexpected);
        expect(saved).toEqual([]);
      });

      it("never saves an HTML page as the file", async () => {
        await submit();
        await answer(
          new Response("<!doctype html><title>Sign in</title>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );

        expect(generalError()).toHaveTextContent(suite.copy.unexpected);
        expect(saved).toEqual([]);
      });

      it("asks a user whose session ended to sign in again", async () => {
        await submit();
        await answer({
          type: "opaqueredirect",
          status: 0,
          ok: false,
          headers: new Headers(),
        } as unknown as Response);

        expect(generalError()).toHaveTextContent(suite.copy.signedOut);
        expect(
          within(generalError()!).getByRole("link", { name: "Sign in again" }),
        ).toHaveAttribute("href", "/login");
        expect(saved).toEqual([]);
      });

      it("says when the server cannot be reached", async () => {
        await submit();
        await answer(new TypeError("Failed to fetch"));

        expect(generalError()).toHaveTextContent(suite.copy.network);
        expect(saved).toEqual([]);
      });

      it("clears the error when the export is tried again, and succeeds", async () => {
        const user = await submit();
        await answer(failure(503, { code: "unavailable", message: "Try again later." }));
        expect(generalError()).toBeInTheDocument();

        await user.click(downloadButton());
        expect(generalError()).toBeNull();
        expect(status()).toHaveTextContent(suite.copy.progress);

        await answer(csvResponse());
        expect(saved).toHaveLength(1);
        expect(status()).toHaveTextContent(
          suite.copy.downloaded(`${suite.fileBase}-2026-04-05.csv`, 25),
        );
      });
    });

    describe(`${suite.name} – cancelling`, () => {
      it("stops the request, saves nothing, says so and keeps focus in the form", async () => {
        const user = userEvent.setup();
        render(suite.element());

        await user.click(downloadButton());
        const { signal } = lastRequest().init;
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(signal?.aborted).toBe(true);
        expect(status()).toHaveTextContent(suite.copy.cancelled);
        expect(downloadButton()).toHaveTextContent("Download CSV");
        expect(downloadButton()).toHaveFocus();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(saved).toEqual([]);
      });

      it("ignores a file that still arrives after cancelling", async () => {
        // A fetch that does not honour its signal (an old browser, a proxy).
        fetchMock.mockImplementationOnce(
          (url: string, init: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              requests.push({ url, init, resolve, reject });
            }),
        );
        const user = userEvent.setup();
        render(suite.element());

        await user.click(downloadButton());
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await answer(csvResponse());

        expect(saved).toEqual([]);
        expect(status()).toHaveTextContent(suite.copy.cancelled);
      });

      it("can start a new export after cancelling", async () => {
        const user = userEvent.setup();
        render(suite.element());

        await user.click(downloadButton());
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await user.click(downloadButton());
        await answer(csvResponse());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(saved).toHaveLength(1);
      });

      it("cancels an export still being prepared when the page is left", async () => {
        const user = userEvent.setup();
        const { unmount } = render(suite.element());

        await user.click(downloadButton());
        const { signal } = lastRequest().init;
        unmount();

        expect(signal?.aborted).toBe(true);
        await waitFor(() => expect(saved).toEqual([]));
      });
    });

    describe(`${suite.name} – server rendering and hydration`, () => {
      it("keeps dates typed before the page finished hydrating, and sends exactly them", async () => {
        // The server's HTML, in the browser before React has taken over…
        const container = document.createElement("div");
        document.body.append(container);
        container.innerHTML = renderToString(suite.element());

        // …where the user is already typing.
        const from = container.querySelector<HTMLInputElement>(
          `#${suite.idPrefix}-from`,
        )!;
        const to = container.querySelector<HTMLInputElement>(`#${suite.idPrefix}-to`)!;
        from.value = "2026-03-01";
        to.value = "2026-03-31";

        const root = await act(async () => hydrateRoot(container, suite.element()));

        try {
          expect(from.value).toBe("2026-03-01");
          expect(to.value).toBe("2026-03-31");

          await act(async () => {
            container.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
          });

          expect(lastRequest().url).toBe(`${suite.path}?from=2026-03-01&to=2026-03-31`);
        } finally {
          act(() => root.unmount());
          container.remove();
        }
      });
    });

    describe(`${suite.name} – too many exports (429)`, () => {
      const limited = (retryAfterSeconds?: number) =>
        failure(429, {
          code: "rate_limited",
          message:
            "You've exported several times in a short while. Please wait a minute.",
          ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
        });

      const countdown = () => document.querySelector<HTMLElement>("[data-export-wait]");

      // The countdown runs on timers; fire events directly rather than through
      // user-event, which would need to be told about fake timers.
      const clickDownload = async () => {
        await act(async () => {
          fireEvent.click(downloadButton());
        });
      };

      beforeEach(() => {
        vi.useFakeTimers({
          toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
        });
        vi.setSystemTime(new Date("2026-04-05T12:00:00Z"));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      const limitedFor = async (seconds?: number) => {
        render(suite.element());
        await clickDownload();
        await answer(limited(seconds));
      };

      it("shows the route's message once, a countdown, and holds the button", async () => {
        await limitedFor(90);

        expect(generalError()).toHaveTextContent(
          "You've exported several times in a short while. Please wait a minute.",
        );
        expect(countdown()).toHaveTextContent(suite.copy.waitCountdown("1:30"));
        expect(downloadButton()).toHaveTextContent(suite.copy.download);
        expect(downloadButton()).toHaveAttribute("aria-disabled", "true");
        expect(downloadButton()).toHaveAccessibleDescription(
          suite.copy.waitCountdown("1:30"),
        );
        expect(saved).toEqual([]);
        expect(status()).toHaveTextContent("");
      });

      it("keeps the ticking countdown out of every live region", async () => {
        await limitedFor(90);

        expect(countdown()).toHaveAttribute("aria-live", "off");
        expect(
          countdown()!.closest(
            "[role=alert], [role=status], [aria-live=polite], [aria-live=assertive]",
          ),
        ).toBeNull();
      });

      it("counts down every second and sends nothing while the wait lasts", async () => {
        await limitedFor(90);

        await act(async () => vi.advanceTimersByTime(1000));
        expect(countdown()).toHaveTextContent(suite.copy.waitCountdown("1:29"));

        await act(async () => vi.advanceTimersByTime(30_000));
        expect(countdown()).toHaveTextContent(suite.copy.waitCountdown("0:59"));

        await clickDownload();
        fireEvent.submit(screen.getByRole("form", { name: suite.copy.formLabel }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("lets the user export again once the wait is over, and says so", async () => {
        await limitedFor(3);

        await act(async () => vi.advanceTimersByTime(3000));

        expect(countdown()).toBeNull();
        expect(generalError()).toBeNull();
        expect(downloadButton()).not.toHaveAttribute("aria-disabled");
        expect(status()).toHaveTextContent(suite.copy.readyAgain);

        await clickDownload();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await answer(csvResponse());
        expect(saved).toHaveLength(1);
      });

      it("still lets the dates be changed while waiting", async () => {
        await limitedFor(60);

        fireEvent.change(fields().from, { target: { value: "2026-03-01" } });

        expect(fields().from.value).toBe("2026-03-01");
        expect(countdown()).toBeInTheDocument();
      });

      it("treats a 429 without a usable wait as a plain failure (no countdown, button free)", async () => {
        await limitedFor(undefined);

        expect(generalError()).toHaveTextContent("Please wait a minute.");
        expect(countdown()).toBeNull();
        expect(downloadButton()).not.toHaveAttribute("aria-disabled");
      });

      it("stops its timer when the page is left", async () => {
        render(suite.element());
        await clickDownload();
        await answer(limited(90));
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        cleanupRendered();

        expect(vi.getTimerCount()).toBe(0);
      });
    });
  });
}
