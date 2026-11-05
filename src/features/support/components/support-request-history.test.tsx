import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadMoreSupportRequestsResult } from "../actions/load-more-support-requests";
import type { ListSupportRequestsResult } from "../services/list-support-requests";
import { SUPPORT_REQUEST_ERRORS } from "../services/support-request-errors";
import { SUPPORT_HISTORY_COPY as COPY } from "../services/support-request-history";
import type { SupportRequest } from "../services/support-request-row";

// NOTHING in the history may navigate: a navigation would take an unsent
// draft in the form with it. Any use of the router or a redirect fails loudly.
const navigation = vi.hoisted(() => ({
  used: vi.fn((what: string) => {
    throw new Error(`the history must not navigate (${what})`);
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => navigation.used("push"),
    replace: () => navigation.used("replace"),
    refresh: () => navigation.used("refresh"),
    back: () => navigation.used("back"),
  }),
  redirect: () => navigation.used("redirect"),
}));

const action = vi.hoisted(() => ({
  loadMoreSupportRequests:
    vi.fn<(cursor: unknown) => Promise<LoadMoreSupportRequestsResult>>(),
}));
vi.mock("../actions/load-more-support-requests", () => action);

const reload = vi.hoisted(() => ({
  reloadSupportRequests: vi.fn<() => Promise<ListSupportRequestsResult>>(),
}));
vi.mock("../actions/reload-support-requests", () => reload);

import { SupportRequestHistory } from "./support-request-history";

// ------------------------------------------------------------------------------

const OWNER = "11111111-1111-4111-8111-111111111111";

const request = (n: number, overrides: Partial<SupportRequest> = {}): SupportRequest => ({
  id: `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(n).padStart(2, "0")}`,
  createdAt: `2026-03-${String(n).padStart(2, "0")}T10:00:00+00:00`,
  category: "billing",
  status: "open",
  subject: `Request ${n}`,
  message: `Details of request ${n}.`,
  ...overrides,
});

const page = (
  requests: SupportRequest[],
  nextCursor: string | null = null,
): Extract<ListSupportRequestsResult, { ok: true }> => ({
  ok: true,
  requests,
  nextCursor,
});

const region = () => screen.getByRole("region", { name: COPY.title });
const list = () => screen.getByRole("list", { name: COPY.listLabel });
const subjects = () =>
  within(list())
    .getAllByRole("heading", { level: 4 })
    .map((h) => h.textContent);
const loadOlderButton = () => screen.getByRole("button", { name: COPY.loadOlder });
const liveRegion = () => screen.getByRole("status");

beforeEach(() => {
  navigation.used.mockClear();
  action.loadMoreSupportRequests.mockReset();
  reload.reloadSupportRequests.mockReset();
});

afterEach(() => {
  expect(navigation.used).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

/** A promise the test settles, for observing pending states. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const signInLink = () => screen.getByRole("link", { name: COPY.signInAgain });

describe("SupportRequestHistory – states", () => {
  it("says when the history could not be read, and claims nothing about what was sent", () => {
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    expect(region()).toHaveAttribute("data-history-state", "unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent(COPY.unavailable);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(region()).not.toHaveTextContent(COPY.empty);
    // Not a session problem: no sign-in link.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("'Try again' reads the first page in place, showing its progress", async () => {
    const user = userEvent.setup();
    const pending = deferred<ListSupportRequestsResult>();
    reload.reloadSupportRequests.mockReturnValue(pending.promise);
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    try {
      await user.click(screen.getByRole("button", { name: COPY.retry }));

      const busy = await screen.findByRole("button", { name: COPY.retryPending });
      expect(busy).toHaveAttribute("aria-disabled", "true");
      expect(busy).toHaveAttribute("aria-busy", "true");

      // Clicks while busy do not start a second read.
      await user.click(busy);
      expect(reload.reloadSupportRequests).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(page([request(1)]));
    }

    await waitFor(() => expect(subjects()).toEqual(["Request 1"]));
    expect(region()).toHaveAttribute("data-history-state", "list");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("'Try again' can land on the empty state", async () => {
    const user = userEvent.setup();
    reload.reloadSupportRequests.mockResolvedValue(page([]));
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: COPY.retry }));

    await waitFor(() => expect(region()).toHaveAttribute("data-history-state", "empty"));
  });

  it("'Try again' that fails again stays unavailable, and can be tried again", async () => {
    const user = userEvent.setup();
    reload.reloadSupportRequests
      .mockResolvedValueOnce({ ok: false, failure: "unavailable" })
      .mockResolvedValueOnce(page([request(1)]));
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: COPY.retry }));
    await waitFor(() => expect(reload.reloadSupportRequests).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: COPY.retry })).toBeInTheDocument();
    expect(region()).toHaveAttribute("data-history-state", "unavailable");

    await user.click(screen.getByRole("button", { name: COPY.retry }));
    await waitFor(() => expect(subjects()).toEqual(["Request 1"]));
  });

  it("'Try again' survives the action itself failing (network)", async () => {
    const user = userEvent.setup();
    reload.reloadSupportRequests.mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: COPY.retry }));

    await waitFor(() => expect(reload.reloadSupportRequests).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: COPY.retry })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(COPY.unavailable);
  });

  it("shows the list once the server hands in a first page", () => {
    const { rerender } = render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    rerender(<SupportRequestHistory ownerId={OWNER} initial={page([request(1)])} />);

    expect(region()).toHaveAttribute("data-history-state", "list");
    expect(subjects()).toEqual(["Request 1"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("has an empty state that says where requests will appear", () => {
    render(<SupportRequestHistory ownerId={OWNER} initial={page([])} />);

    expect(region()).toHaveAttribute("data-history-state", "empty");
    expect(region()).toHaveTextContent(COPY.empty);
    expect(region()).toHaveTextContent(COPY.emptyHint);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not claim 'empty' when a page held nothing displayable but older requests exist", () => {
    render(<SupportRequestHistory ownerId={OWNER} initial={page([], "cursor-1")} />);

    expect(region()).toHaveAttribute("data-history-state", "list");
    expect(region()).toHaveTextContent(COPY.emptyPageWithMore);
    expect(region()).not.toHaveTextContent(COPY.empty);
    expect(loadOlderButton()).toBeInTheDocument();
  });
});

describe("SupportRequestHistory – pages with nothing displayable", () => {
  it("paging to the end without finding anything displayable says so — not 'no requests'", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValue({
      ok: true,
      cursor: "cursor-1",
      requests: [],
      nextCursor: null,
    });
    render(<SupportRequestHistory ownerId={OWNER} initial={page([], "cursor-1")} />);
    expect(region()).toHaveTextContent(COPY.emptyPageWithMore);

    await user.click(loadOlderButton());

    await waitFor(() => expect(region()).toHaveTextContent(COPY.nothingToShow));
    expect(region()).not.toHaveTextContent(COPY.empty);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: COPY.loadOlder }),
    ).not.toBeInTheDocument();
  });
});

describe("SupportRequestHistory – a request", () => {
  it("shows subject, status, category and when it was sent; the message on demand", async () => {
    const user = userEvent.setup();
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([
          request(1, { subject: "Charged twice", message: "Line one\nLine two" }),
        ])}
      />,
    );

    const item = within(list()).getByRole("article", { name: "Charged twice" });
    expect(item).toHaveTextContent("Open");
    expect(item).toHaveTextContent("Billing");
    const time = item.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-03-01T10:00:00+00:00");
    expect(time).toHaveTextContent("Sent 1 Mar 2026, 10:00 UTC");

    // Collapsed until asked for, then shown with its line breaks.
    const details = item.querySelector("details")!;
    expect(details.open).toBe(false);
    await user.click(within(item).getByText(COPY.showMessage));
    expect(details.open).toBe(true);
    expect(within(details).getByText(/Line one/)).toHaveClass("whitespace-pre-wrap");
  });

  it("labels closed requests", () => {
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(1, { status: "closed" })])}
      />,
    );

    expect(within(list()).getByRole("article")).toHaveTextContent("Closed");
  });

  it("labels values this version does not know neutrally, never as raw identifiers", () => {
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(1, { category: null, status: null })])}
      />,
    );

    const item = within(list()).getByRole("article");
    expect(item).toHaveTextContent("General");
    expect(item).toHaveTextContent("Unknown");
    expect(item).not.toHaveTextContent("null");
  });

  it("says so when the time cannot be read", () => {
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(1, { createdAt: "garbage" })])}
      />,
    );

    expect(within(list()).getByRole("article")).toHaveTextContent(
      "Sent at an unknown time",
    );
  });

  it("never shows the request id", () => {
    const first = request(1);
    render(<SupportRequestHistory ownerId={OWNER} initial={page([first])} />);

    expect(region()).not.toHaveTextContent(first.id);
  });
});

describe("SupportRequestHistory – paging", () => {
  it("offers older requests only when there are more", () => {
    const { rerender } = render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], null)} />,
    );

    expect(
      screen.queryByRole("button", { name: COPY.loadOlder }),
    ).not.toBeInTheDocument();

    rerender(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );
    expect(loadOlderButton()).toBeInTheDocument();
  });

  it("appends the next page, announces it, and pages on with the new cursor", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests
      .mockResolvedValueOnce({
        ok: true,
        cursor: "cursor-1",
        requests: [request(4), request(3)],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        ok: true,
        cursor: "cursor-2",
        requests: [request(2)],
        nextCursor: null,
      });
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(6), request(5)], "cursor-1")}
      />,
    );

    await user.click(loadOlderButton());

    await waitFor(() =>
      expect(subjects()).toEqual(["Request 6", "Request 5", "Request 4", "Request 3"]),
    );
    expect(action.loadMoreSupportRequests).toHaveBeenLastCalledWith("cursor-1", OWNER);
    expect(liveRegion()).toHaveTextContent("Loaded 2 older requests. 4 requests shown.");

    await user.click(loadOlderButton());

    await waitFor(() => expect(subjects()).toHaveLength(5));
    expect(action.loadMoreSupportRequests).toHaveBeenLastCalledWith("cursor-2", OWNER);
  });

  it("at the end, removes the button and moves focus to the message that replaces it", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValue({
      ok: true,
      cursor: "cursor-1",
      requests: [request(1)],
      nextCursor: null,
    });
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());

    await waitFor(() => expect(liveRegion()).toHaveTextContent(COPY.end));
    expect(
      screen.queryByRole("button", { name: COPY.loadOlder }),
    ).not.toBeInTheDocument();
    expect(liveRegion()).toHaveFocus();
  });

  it("shows a loading state and sends one request at a time", async () => {
    const user = userEvent.setup();
    let finish!: (value: LoadMoreSupportRequestsResult) => void;
    action.loadMoreSupportRequests.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    // React entangles pending async actions: settle it even if an assertion fails.
    try {
      await user.click(loadOlderButton());

      const busy = await screen.findByRole("button", { name: COPY.loadOlderPending });
      // aria-disabled, not disabled: keyboard focus stays on the button.
      expect(busy).toHaveAttribute("aria-disabled", "true");
      expect(busy).toHaveAttribute("aria-busy", "true");
      expect(busy).toBeEnabled();
      expect(liveRegion()).toHaveTextContent(COPY.loadOlderPending);

      await user.click(busy);
      await user.click(busy);
      expect(action.loadMoreSupportRequests).toHaveBeenCalledTimes(1);
    } finally {
      finish({ ok: true, cursor: "cursor-1", requests: [request(1)], nextCursor: null });
    }

    await waitFor(() => expect(subjects()).toEqual(["Request 2", "Request 1"]));
  });

  it("keeps what is shown when a page fails, and a retry can succeed", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests
      .mockResolvedValueOnce({
        ok: false,
        cursor: "cursor-1",
        error: SUPPORT_REQUEST_ERRORS.listUnavailable,
        recovery: "retry",
      })
      .mockResolvedValueOnce({
        ok: true,
        cursor: "cursor-1",
        requests: [request(1)],
        nextCursor: null,
      });
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.listUnavailable,
    );
    expect(subjects()).toEqual(["Request 2"]);

    await user.click(loadOlderButton());

    await waitFor(() => expect(subjects()).toEqual(["Request 2", "Request 1"]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("turns a thrown action (network) into a retryable failure", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.listUnavailable,
    );
    expect(loadOlderButton()).toBeInTheDocument();
    expect(subjects()).toEqual(["Request 2"]);
  });

  it("never appends a response that answers a different cursor", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValue({
      ok: true,
      cursor: "some-other-cursor",
      requests: [request(1)],
      nextCursor: null,
    });
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());

    await screen.findByRole("alert");
    expect(subjects()).toEqual(["Request 2"]);
  });

  it("does not show a request twice when a page overlaps what is shown", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValue({
      ok: true,
      cursor: "cursor-1",
      requests: [request(2), request(1)],
      nextCursor: null,
    });
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(3), request(2)], "cursor-1")}
      />,
    );

    await user.click(loadOlderButton());

    await waitFor(() =>
      expect(subjects()).toEqual(["Request 3", "Request 2", "Request 1"]),
    );
    expect(liveRegion()).toHaveTextContent("Loaded 1 older request.");
  });

  it("when the cursor is no longer valid, reloads from the first page in place", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests
      .mockResolvedValueOnce({
        ok: true,
        cursor: "cursor-1",
        requests: [request(3)],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        ok: false,
        cursor: "cursor-2",
        error: SUPPORT_REQUEST_ERRORS.listRestart,
        recovery: "reload",
      });
    const pending = deferred<ListSupportRequestsResult>();
    reload.reloadSupportRequests.mockReturnValue(pending.promise);
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(5), request(4)], "cursor-1")}
      />,
    );

    await user.click(loadOlderButton());
    await waitFor(() => expect(subjects()).toHaveLength(3));
    await user.click(loadOlderButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.listRestart,
    );
    // Asking for the same cursor again cannot help, so that button is gone.
    expect(
      screen.queryByRole("button", { name: COPY.loadOlder }),
    ).not.toBeInTheDocument();

    try {
      await user.click(screen.getByRole("button", { name: COPY.reload }));

      // The reload keeps its own button while busy (not "Load older").
      const busy = await screen.findByRole("button", { name: COPY.reloadPending });
      expect(busy).toHaveAttribute("aria-busy", "true");
      expect(liveRegion()).toHaveTextContent(COPY.reloadPending);
      expect(
        screen.queryByRole("button", { name: COPY.loadOlder }),
      ).not.toBeInTheDocument();
      // What is shown stays while the reload runs.
      expect(subjects()).toHaveLength(3);

      // Clicks while busy do not start a second reload.
      await user.click(busy);
      await user.click(busy);
      expect(reload.reloadSupportRequests).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(page([request(6), request(5)], "cursor-fresh"));
    }

    await waitFor(() => expect(subjects()).toEqual(["Request 6", "Request 5"]));
    expect(liveRegion()).toHaveTextContent(COPY.reloaded);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Paging continues from the fresh cursor.
    action.loadMoreSupportRequests.mockResolvedValueOnce({
      ok: true,
      cursor: "cursor-fresh",
      requests: [request(4)],
      nextCursor: null,
    });
    await user.click(loadOlderButton());
    await waitFor(() => expect(subjects()).toHaveLength(3));
    expect(action.loadMoreSupportRequests).toHaveBeenLastCalledWith(
      "cursor-fresh",
      OWNER,
    );
  });

  it("a reload that fails keeps the list and offers the reload again", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValueOnce({
      ok: false,
      cursor: "cursor-1",
      error: SUPPORT_REQUEST_ERRORS.listRestart,
      recovery: "reload",
    });
    reload.reloadSupportRequests
      .mockResolvedValueOnce({ ok: false, failure: "unavailable" })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(page([request(9)]));
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());
    await user.click(await screen.findByRole("button", { name: COPY.reload }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.listUnavailable,
    );
    expect(subjects()).toEqual(["Request 2"]);

    await user.click(screen.getByRole("button", { name: COPY.reload }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.listUnavailable,
    );

    await user.click(screen.getByRole("button", { name: COPY.reload }));
    await waitFor(() => expect(subjects()).toEqual(["Request 9"]));
  });
});

describe("SupportRequestHistory – an ended session", () => {
  it("on the first page: explains, offers to sign in in a new tab, and retries in place", async () => {
    const user = userEvent.setup();
    reload.reloadSupportRequests
      .mockResolvedValueOnce({ ok: false, failure: "sessionExpired" })
      .mockResolvedValueOnce(page([request(1)]));
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "sessionExpired" }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.listSessionExpired);
    expect(signInLink()).toHaveAttribute("href", "/login");
    expect(signInLink()).toHaveAttribute("target", "_blank");
    expect(signInLink()).toHaveAttribute("rel", expect.stringContaining("noopener"));

    // Still signed out: the same state, the same way out.
    await user.click(screen.getByRole("button", { name: COPY.retry }));
    await waitFor(() => expect(reload.reloadSupportRequests).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("link", { name: COPY.signInAgain }),
    ).toBeInTheDocument();

    // Signed in (in the other tab): the same button now works.
    await user.click(screen.getByRole("button", { name: COPY.retry }));
    await waitFor(() => expect(subjects()).toEqual(["Request 1"]));
    expect(
      screen.queryByRole("link", { name: COPY.signInAgain }),
    ).not.toBeInTheDocument();
  });

  it("a retry that finds the session ended turns 'unavailable' into 'sign in again'", async () => {
    const user = userEvent.setup();
    reload.reloadSupportRequests.mockResolvedValue({
      ok: false,
      failure: "sessionExpired",
    });
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: COPY.retry }));

    expect(
      await screen.findByRole("link", { name: COPY.signInAgain }),
    ).toBeInTheDocument();
  });

  it("while paging: keeps the list, offers to sign in, and the same button then loads the page", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests
      .mockResolvedValueOnce({
        ok: false,
        cursor: "cursor-1",
        error: SUPPORT_REQUEST_ERRORS.listSessionExpired,
        recovery: "signIn",
      })
      .mockResolvedValueOnce({
        ok: true,
        cursor: "cursor-1",
        requests: [request(1)],
        nextCursor: null,
      });
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.listSessionExpired);
    expect(within(alert).getByRole("link", { name: COPY.signInAgain })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(subjects()).toEqual(["Request 2"]);
    // Not a reload: the cursor is fine, only the session is missing.
    expect(screen.queryByRole("button", { name: COPY.reload })).not.toBeInTheDocument();

    await user.click(loadOlderButton());

    await waitFor(() => expect(subjects()).toEqual(["Request 2", "Request 1"]));
    expect(action.loadMoreSupportRequests).toHaveBeenLastCalledWith("cursor-1", OWNER);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("during a reload: keeps the list, offers to sign in, and keeps offering the reload", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValueOnce({
      ok: false,
      cursor: "cursor-1",
      error: SUPPORT_REQUEST_ERRORS.listRestart,
      recovery: "reload",
    });
    reload.reloadSupportRequests
      .mockResolvedValueOnce({ ok: false, failure: "sessionExpired" })
      .mockResolvedValueOnce(page([request(7)]));
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());
    await user.click(await screen.findByRole("button", { name: COPY.reload }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.listSessionExpired);
    expect(
      within(alert).getByRole("link", { name: COPY.signInAgain }),
    ).toBeInTheDocument();
    expect(subjects()).toEqual(["Request 2"]);

    // After signing in, it is still a reload (the old cursor is still bad).
    await user.click(screen.getByRole("button", { name: COPY.reload }));
    await waitFor(() => expect(subjects()).toEqual(["Request 7"]));
  });
});

describe("SupportRequestHistory – one account per list", () => {
  it("every read it makes names the account the list belongs to", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValue({
      ok: false,
      cursor: "cursor-1",
      error: SUPPORT_REQUEST_ERRORS.listRestart,
      recovery: "reload",
    });
    reload.reloadSupportRequests.mockResolvedValue(page([request(3)]));
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());
    await user.click(await screen.findByRole("button", { name: COPY.reload }));
    await waitFor(() => expect(subjects()).toEqual(["Request 3"]));

    expect(action.loadMoreSupportRequests).toHaveBeenCalledWith("cursor-1", OWNER);
    expect(reload.reloadSupportRequests).toHaveBeenCalledWith(OWNER);
  });

  it("paging refused for another account: keeps this account's list, adds nothing, explains", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests
      .mockResolvedValueOnce({
        ok: false,
        cursor: "cursor-1",
        error: SUPPORT_REQUEST_ERRORS.listAccountChanged,
        recovery: "accountChanged",
      })
      .mockResolvedValueOnce({
        ok: true,
        cursor: "cursor-1",
        requests: [request(1)],
        nextCursor: null,
      });
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.listAccountChanged);
    expect(within(alert).getByRole("link", { name: COPY.signInAgain })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(subjects()).toEqual(["Request 2"]);

    // Signed back in to the list's account: the same page loads.
    await user.click(loadOlderButton());
    await waitFor(() => expect(subjects()).toEqual(["Request 2", "Request 1"]));
  });

  it("a reload refused for another account keeps this account's list", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValue({
      ok: false,
      cursor: "cursor-1",
      error: SUPPORT_REQUEST_ERRORS.listRestart,
      recovery: "reload",
    });
    reload.reloadSupportRequests.mockResolvedValue({
      ok: false,
      failure: "accountChanged",
    });
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2)], "cursor-1")} />,
    );

    await user.click(loadOlderButton());
    await user.click(await screen.findByRole("button", { name: COPY.reload }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.listAccountChanged);
    expect(
      within(alert).getByRole("link", { name: COPY.signInAgain }),
    ).toBeInTheDocument();
    expect(subjects()).toEqual(["Request 2"]);
    expect(screen.getByRole("button", { name: COPY.reload })).toBeInTheDocument();
  });

  it("'Try again' refused for another account: explains, offers sign-in, shows nothing of theirs", async () => {
    const user = userEvent.setup();
    reload.reloadSupportRequests.mockResolvedValue({
      ok: false,
      failure: "accountChanged",
    });
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: COPY.retry }));

    expect(
      await screen.findByText(SUPPORT_REQUEST_ERRORS.listAccountChanged),
    ).toBeInTheDocument();
    expect(signInLink()).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(region()).toHaveAttribute("data-history-state", "unavailable");
  });

  it("a first page refused for another account says so (not 'unavailable', not 'empty')", () => {
    render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "accountChanged" }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.listAccountChanged,
    );
    expect(region()).not.toHaveTextContent(COPY.unavailable);
    expect(region()).not.toHaveTextContent(COPY.empty);
  });
});

describe("SupportRequestHistory – staying current", () => {
  it("shows a newly sent request at the top when the page is revalidated", () => {
    const { rerender } = render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2), request(1)])} />,
    );

    rerender(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(3, { subject: "Just sent" }), request(2), request(1)])}
      />,
    );

    expect(subjects()).toEqual(["Just sent", "Request 2", "Request 1"]);
  });

  it("replaces the empty state with the first request ever sent", () => {
    const { rerender } = render(
      <SupportRequestHistory ownerId={OWNER} initial={page([])} />,
    );

    rerender(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(1, { subject: "First" })])}
      />,
    );

    expect(region()).toHaveAttribute("data-history-state", "list");
    expect(subjects()).toEqual(["First"]);
    expect(region()).not.toHaveTextContent(COPY.empty);
  });

  it("a new first page replaces older pages that were loaded (they can be loaded again)", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValue({
      ok: true,
      cursor: "cursor-1",
      requests: [request(3)],
      nextCursor: "cursor-2",
    });
    const { rerender } = render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(5), request(4)], "cursor-1")}
      />,
    );

    await user.click(loadOlderButton());
    await waitFor(() => expect(subjects()).toHaveLength(3));

    rerender(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(6), request(5)], "cursor-new")}
      />,
    );

    expect(subjects()).toEqual(["Request 6", "Request 5"]);
    expect(loadOlderButton()).toBeInTheDocument();
  });

  it("a re-render with the same first page keeps loaded pages and the status message", async () => {
    const user = userEvent.setup();
    action.loadMoreSupportRequests.mockResolvedValue({
      ok: true,
      cursor: "cursor-1",
      requests: [request(3)],
      nextCursor: "cursor-2",
    });
    const initial = page([request(5), request(4)], "cursor-1");
    const { rerender } = render(
      <SupportRequestHistory ownerId={OWNER} initial={initial} />,
    );

    await user.click(loadOlderButton());
    await waitFor(() => expect(subjects()).toHaveLength(3));

    // e.g. a failed submission re-rendered the page; the data did not change.
    rerender(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ...initial, requests: [...initial.requests] }}
      />,
    );

    expect(subjects()).toEqual(["Request 5", "Request 4", "Request 3"]);
    expect(liveRegion()).toHaveTextContent("Loaded 1 older request.");
  });

  it("shows a status change made by support", () => {
    const { rerender } = render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(1)])} />,
    );
    expect(within(list()).getByRole("article")).toHaveTextContent("Open");

    rerender(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={page([request(1, { status: "closed" })])}
      />,
    );

    expect(within(list()).getByRole("article")).toHaveTextContent("Closed");
  });

  it("a page fetched by 'Try again' gives way to the next one the server hands in", async () => {
    const user = userEvent.setup();
    reload.reloadSupportRequests.mockResolvedValue(page([request(1)]));
    const { rerender } = render(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: COPY.retry }));
    await waitFor(() => expect(subjects()).toEqual(["Request 1"]));

    // A request was sent: the route re-rendered with a newer first page.
    rerender(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2), request(1)])} />,
    );

    expect(subjects()).toEqual(["Request 2", "Request 1"]);
  });

  it("if a later refresh cannot read the history, says so rather than showing stale data", () => {
    const { rerender } = render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(1)])} />,
    );

    rerender(
      <SupportRequestHistory
        ownerId={OWNER}
        initial={{ ok: false, failure: "unavailable" }}
      />,
    );

    expect(region()).toHaveAttribute("data-history-state", "unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent(COPY.unavailable);
  });
});

describe("SupportRequestHistory – accessibility", () => {
  it("is a named region with a heading, and the list is a labelled ordered list", () => {
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(2), request(1)])} />,
    );

    expect(within(region()).getByRole("heading", { level: 3 })).toHaveTextContent(
      COPY.title,
    );
    expect(list().tagName).toBe("OL");
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps one polite live region mounted, silent until something happens", () => {
    render(
      <SupportRequestHistory ownerId={OWNER} initial={page([request(1)], "cursor-1")} />,
    );

    expect(liveRegion()).toHaveAttribute("aria-live", "polite");
    expect(liveRegion()).toHaveTextContent("");
    expect(liveRegion()).toHaveClass("sr-only");
  });
});
