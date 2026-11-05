/**
 * The exports page with both cards: each works on its own. Requests are
 * held until the test answers them, by path, so the two exports can be
 * interleaved — one loading while the other finishes, fails or is cancelled.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INVOICE_EXPORT_COPY } from "@/features/billing/components/invoice-export-card";
import { INVOICE_DOWNLOAD_PATH } from "@/features/billing/services/invoice-download-path";
import { ACCOUNT_ACTIVITY_EXPORT_COPY } from "@/features/settings/components/account-activity-export-card";
import { ACCOUNT_ACTIVITY_DOWNLOAD_PATH } from "@/features/settings/services/account-activity-download-path";
import { DATE_RANGE_ERRORS } from "@/shared/utils/date-range";

import ExportsPage from "./page";

type Pending = {
  url: string;
  init: RequestInit;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

let requests: Pending[] = [];
let saved: string[] = [];

const fetchMock = vi.fn(
  (url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      requests.push({ url, init, resolve, reject });
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    }),
);

/** The open request to `path` (query string ignored). */
const requestTo = (path: string) => {
  const found = requests.filter((r) => r.url.split("?")[0] === path);
  if (found.length === 0) throw new Error(`no request to ${path}`);
  return found[found.length - 1];
};

const csv = (fileName: string, rowCount: string) =>
  new Response("\uFEFFheader\r\n", {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "x-export-row-count": rowCount,
    },
  });

const failure = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

const answer = async (path: string, response: Response) => {
  const pending = requestTo(path);
  await act(async () => pending.resolve(response));
};

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
    saved.push(this.download);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Each card, found by its form. */
const card = (formLabel: string) => {
  const form = screen.getByRole("form", { name: formLabel });
  return {
    form,
    from: within(form).getByLabelText("From") as HTMLInputElement,
    to: within(form).getByLabelText("To") as HTMLInputElement,
    button: () => within(form).getByRole("button", { name: /Download CSV|Preparing/ }),
    cancel: () => within(form).getByRole("button", { name: "Cancel" }),
    status: () => within(form).getByRole("status"),
    error: () => form.querySelector<HTMLElement>("[data-export-error]"),
  };
};

const invoices = () => card(INVOICE_EXPORT_COPY.formLabel);
const activity = () => card(ACCOUNT_ACTIVITY_EXPORT_COPY.formLabel);

describe("/exports", () => {
  it("introduces the page and offers both exports, each with its own dates and button", () => {
    render(<ExportsPage />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Exports" }),
    ).toBeInTheDocument();
    for (const { from, to, button } of [invoices(), activity()]) {
      expect(from).toHaveAttribute("type", "date");
      expect(to).toHaveAttribute("type", "date");
      expect(button()).toHaveTextContent("Download CSV");
    }
    expect(screen.getByText("Invoices")).toBeInTheDocument();
    expect(screen.getByText("Account activity")).toBeInTheDocument();
  });

  it("has no duplicate ids, so every label and message belongs to its own card", () => {
    render(<ExportsPage />);

    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(invoices().from.id).not.toBe(activity().from.id);
    expect(invoices().from).toHaveAccessibleDescription(INVOICE_EXPORT_COPY.datesHint);
    expect(activity().from).toHaveAccessibleDescription(
      ACCOUNT_ACTIVITY_EXPORT_COPY.datesHint,
    );
  });

  it("reads nothing while rendering, so no user data can fail it", () => {
    expect(ExportsPage()).not.toBeInstanceOf(Promise);
  });
});

describe("/exports – the two exports work independently", () => {
  it("sends each card's own dates to its own route", async () => {
    const user = userEvent.setup();
    render(<ExportsPage />);

    fireEvent.change(invoices().from, { target: { value: "2026-01-01" } });
    fireEvent.change(invoices().to, { target: { value: "2026-03-31" } });
    fireEvent.change(activity().from, { target: { value: "2026-03-15" } });

    await user.click(invoices().button());
    await user.click(activity().button());

    expect(requests.map((r) => r.url)).toEqual([
      `${INVOICE_DOWNLOAD_PATH}?from=2026-01-01&to=2026-03-31`,
      `${ACCOUNT_ACTIVITY_DOWNLOAD_PATH}?from=2026-03-15`,
    ]);
  });

  it("runs both at once, each with its own loading state, and saves both files", async () => {
    const user = userEvent.setup();
    render(<ExportsPage />);

    await user.click(invoices().button());
    await user.click(activity().button());

    expect(invoices().button()).toHaveAttribute("aria-busy", "true");
    expect(activity().button()).toHaveAttribute("aria-busy", "true");
    expect(invoices().status()).toHaveTextContent(INVOICE_EXPORT_COPY.progress);
    expect(activity().status()).toHaveTextContent(ACCOUNT_ACTIVITY_EXPORT_COPY.progress);

    // Activity finishes first; invoices are still being prepared.
    await answer(
      ACCOUNT_ACTIVITY_DOWNLOAD_PATH,
      csv("account-activity-2026-04-05.csv", "12"),
    );
    expect(saved).toEqual(["account-activity-2026-04-05.csv"]);
    expect(activity().status()).toHaveTextContent(
      "Downloaded account-activity-2026-04-05.csv with 12 entries.",
    );
    expect(invoices().button()).toHaveAttribute("aria-busy", "true");
    expect(invoices().status()).toHaveTextContent(INVOICE_EXPORT_COPY.progress);

    await answer(INVOICE_DOWNLOAD_PATH, csv("invoices-2026-04-05.csv", "25"));
    expect(saved).toEqual(["account-activity-2026-04-05.csv", "invoices-2026-04-05.csv"]);
    expect(invoices().status()).toHaveTextContent(
      "Downloaded invoices-2026-04-05.csv with 25 invoices.",
    );
    expect(activity().status()).toHaveTextContent(
      "Downloaded account-activity-2026-04-05.csv with 12 entries.",
    );
  });

  it("keeps one export's failure in its own card while the other succeeds", async () => {
    const user = userEvent.setup();
    render(<ExportsPage />);

    await user.click(invoices().button());
    await user.click(activity().button());
    await answer(
      INVOICE_DOWNLOAD_PATH,
      failure(409, "ambiguous", "Your invoices can't be exported safely."),
    );

    expect(invoices().error()).toHaveTextContent(
      "Your invoices can't be exported safely.",
    );
    expect(activity().error()).toBeNull();
    expect(activity().button()).toHaveAttribute("aria-busy", "true");

    await answer(
      ACCOUNT_ACTIVITY_DOWNLOAD_PATH,
      csv("account-activity-2026-04-05.csv", "3"),
    );
    expect(saved).toEqual(["account-activity-2026-04-05.csv"]);
    expect(invoices().error()).toHaveTextContent(
      "Your invoices can't be exported safely.",
    );
  });

  it("cancels only the export whose Cancel was pressed", async () => {
    const user = userEvent.setup();
    render(<ExportsPage />);

    await user.click(invoices().button());
    await user.click(activity().button());
    const invoiceSignal = requestTo(INVOICE_DOWNLOAD_PATH).init.signal!;
    const activitySignal = requestTo(ACCOUNT_ACTIVITY_DOWNLOAD_PATH).init.signal!;

    await user.click(activity().cancel());

    expect(activitySignal.aborted).toBe(true);
    expect(invoiceSignal.aborted).toBe(false);
    expect(activity().status()).toHaveTextContent(ACCOUNT_ACTIVITY_EXPORT_COPY.cancelled);
    expect(invoices().button()).toHaveAttribute("aria-busy", "true");

    await answer(INVOICE_DOWNLOAD_PATH, csv("invoices-2026-04-05.csv", "25"));
    expect(saved).toEqual(["invoices-2026-04-05.csv"]);
  });

  it("keeps a date error in its own card and lets the other export go ahead", async () => {
    const user = userEvent.setup();
    render(<ExportsPage />);

    fireEvent.change(activity().from, { target: { value: "2026-04-01" } });
    fireEvent.change(activity().to, { target: { value: "2026-03-01" } });
    await user.click(activity().button());

    expect(within(activity().form).getByRole("alert")).toHaveTextContent(
      DATE_RANGE_ERRORS.range,
    );
    expect(activity().from).toHaveAttribute("aria-invalid", "true");
    expect(invoices().from).not.toHaveAttribute("aria-invalid");
    expect(within(invoices().form).queryByRole("alert")).not.toBeInTheDocument();

    await user.click(invoices().button());
    expect(requests.map((r) => r.url)).toEqual([INVOICE_DOWNLOAD_PATH]);
  });

  it("lets each card start again on its own after a failure", async () => {
    const user = userEvent.setup();
    render(<ExportsPage />);

    await user.click(activity().button());
    await answer(
      ACCOUNT_ACTIVITY_DOWNLOAD_PATH,
      failure(503, "unavailable", "We couldn't export your account activity right now."),
    );
    expect(activity().error()).toBeInTheDocument();

    await user.click(invoices().button());
    await answer(INVOICE_DOWNLOAD_PATH, csv("invoices-2026-04-05.csv", "1"));
    // The invoice success does not clear or touch the activity error.
    expect(activity().error()).toHaveTextContent(
      "We couldn't export your account activity",
    );

    await user.click(activity().button());
    expect(activity().error()).toBeNull();
    await answer(
      ACCOUNT_ACTIVITY_DOWNLOAD_PATH,
      csv("account-activity-2026-04-05.csv", "0"),
    );
    expect(activity().status()).toHaveTextContent(
      "Downloaded account-activity-2026-04-05.csv. There is no account activity in this period.",
    );
    expect(saved).toEqual(["invoices-2026-04-05.csv", "account-activity-2026-04-05.csv"]);
  });

  it("holds only the invoice card while its export allowance refills", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      render(<ExportsPage />);

      await act(async () => fireEvent.click(invoices().button()));
      await answer(
        INVOICE_DOWNLOAD_PATH,
        new Response(
          JSON.stringify({
            error: {
              code: "rate_limited",
              message: "Please wait.",
              retryAfterSeconds: 60,
            },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "60" },
          },
        ),
      );

      expect(invoices().button()).toHaveAttribute("aria-disabled", "true");
      expect(invoices().form.querySelector("[data-export-wait]")).toBeInTheDocument();
      expect(activity().button()).not.toHaveAttribute("aria-disabled");
      expect(activity().form.querySelector("[data-export-wait]")).toBeNull();

      // The activity export goes ahead during the invoice wait.
      await act(async () => fireEvent.click(activity().button()));
      await answer(
        ACCOUNT_ACTIVITY_DOWNLOAD_PATH,
        csv("account-activity-2026-04-05.csv", "4"),
      );
      expect(saved).toEqual(["account-activity-2026-04-05.csv"]);
      expect(invoices().button()).toHaveAttribute("aria-disabled", "true");
    } finally {
      vi.useRealTimers();
    }
  });
});
