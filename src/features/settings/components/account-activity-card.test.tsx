import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountActivityEntry } from "@/infrastructure/account-activity/list-account-activity";

import type { LoadMoreAccountActivityResult } from "../actions/load-more-account-activity";
import { LOAD_MORE_ACTIVITY_COPY } from "../services/account-activity-copy";

// The card calls the server action; substitute it with a controllable fake.
const action = vi.hoisted(() => ({
  loadMoreAccountActivity:
    vi.fn<(cursor: unknown) => Promise<LoadMoreAccountActivityResult>>(),
}));
vi.mock("../actions/load-more-account-activity", () => action);

import { ACCOUNT_ACTIVITY_EVENT_SCHEMA } from "@/infrastructure/account-activity/events";

import {
  AccountActivityCard,
  accountActivityState,
  ACTIVITY_ICONS,
  appendEntries,
  EMPTY_ACTIVITY_TEXT,
  EMPTY_PAGE_WITH_MORE_TEXT,
  END_OF_ACTIVITY_TEXT,
  firstPageKey,
  LOAD_OLDER_LABEL,
  LOAD_OLDER_PENDING_LABEL,
  loadedAnnouncement,
  NOTHING_TO_SHOW_TEXT,
  RELOAD_LABEL,
  UNAVAILABLE_ACTIVITY_TEXT,
} from "./account-activity-card";

const entry = (
  id: number,
  to = `Name ${id}`,
  from: string | null = "Old",
): AccountActivityEntry => ({
  id,
  occurredAt: `2026-03-${String(id).padStart(2, "0")}T10:00:00+00:00`,
  event: { type: "profile.updated", details: { changes: { fullName: { from, to } } } },
});

// Opaque to this component: it only hands cursors back to the action.
const CURSOR_1 = "cursor-after-2";
const CURSOR_2 = "cursor-after-4";

const ok = (
  cursor: string,
  ids: number[],
  nextCursor: string | null,
): LoadMoreAccountActivityResult => ({
  ok: true,
  cursor,
  entries: ids.map((id) => entry(id)),
  nextCursor,
});

const failed = (cursor: string, restart = false): LoadMoreAccountActivityResult => ({
  ok: false,
  cursor,
  error: restart ? LOAD_MORE_ACTIVITY_COPY.restart : LOAD_MORE_ACTIVITY_COPY.retry,
  restart,
});

/** A promise the test resolves by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const list = () => screen.getByRole("list", { name: "Account activity" });
/** The event nodes of the timeline, in document order (day headings excluded). */
const events = () =>
  within(list())
    .queryAllByRole("listitem")
    .filter((item) => item.hasAttribute("data-activity-event"));
/** The day groups, in document order. */
const days = () =>
  within(list())
    .queryAllByRole("listitem")
    .filter((item) => item.hasAttribute("data-activity-day"));
const shownDetails = () =>
  events().map((item) => item.querySelector("p + p")?.textContent);
const loadOlderButton = () => screen.queryByRole("button", { name: LOAD_OLDER_LABEL });
/** Clicks "load older" and waits for the request to settle (the action's result is applied in a transition). */
const loadOlder = async () => {
  await userEvent.click(loadOlderButton()!);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: LOAD_OLDER_PENDING_LABEL }),
    ).not.toBeInTheDocument(),
  );
};
const status = () => screen.getByRole("status");

const renderList = (ids: number[], nextCursor: string | null) =>
  render(
    <AccountActivityCard
      initial={{ ok: true, entries: ids.map((id) => entry(id)), nextCursor }}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AccountActivityCard – shapes", () => {
  it("is a settings card with a real heading", () => {
    const { container } = renderList([2, 1], null);

    expect(
      screen.getByRole("heading", { level: 3, name: "Account activity" }),
    ).toBeVisible();
    expect(container.querySelector('[data-settings-section="activity"]')).toHaveAttribute(
      "data-activity-state",
      "list",
    );
  });

  it("shows the entries in the order given, each with what changed and when", () => {
    renderList([2, 1], null);

    const items = events();
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("data-activity-event", "profile.updated");
    expect(items[0]).toHaveTextContent("Display name changed");
    expect(items[0]).toHaveTextContent("From “Old” to “Name 2”.");
    expect(items[0].querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-03-02T10:00:00+00:00",
    );
    // The day is the heading above; the node shows the time of day.
    expect(items[0].querySelector("time")).toHaveTextContent("10:00 UTC");
    expect(items[0].querySelector("time")).not.toHaveTextContent("2026");
    expect(items[1]).toHaveTextContent("From “Old” to “Name 1”.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the name was set when there was none before", () => {
    render(
      <AccountActivityCard
        initial={{ ok: true, entries: [entry(1, "Jane", null)], nextCursor: null }}
      />,
    );

    expect(list()).toHaveTextContent("Set to “Jane”.");
  });

  it("shows password changes and session sign-outs alongside profile changes", () => {
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          entries: [
            {
              id: 3,
              occurredAt: "2026-03-03T10:00:00+00:00",
              event: { type: "sessions.others_signed_out", details: {} },
            },
            {
              id: 2,
              occurredAt: "2026-03-02T10:00:00+00:00",
              event: {
                type: "password.changed",
                details: { otherSessionsSignedOut: true },
              },
            },
            entry(1, "Jane", null),
          ],
          nextCursor: null,
        }}
      />,
    );

    const items = events();
    expect(items[0]).toHaveAttribute("data-activity-event", "sessions.others_signed_out");
    expect(items[0]).toHaveTextContent("Other sessions signed out");
    expect(items[1]).toHaveAttribute("data-activity-event", "password.changed");
    expect(items[1]).toHaveTextContent("Password changed");
    expect(items[1]).toHaveTextContent("Other sessions were signed out.");
    expect(items[2]).toHaveTextContent("Display name changed");
  });

  it("shows an email change as requested until a later entry says it is done", () => {
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          entries: [
            {
              id: 3,
              occurredAt: "2026-03-03T10:00:00+00:00",
              event: { type: "email.changed", details: { to: "jane.new@example.com" } },
            },
            {
              id: 2,
              occurredAt: "2026-03-02T10:00:00+00:00",
              event: {
                type: "email.change_requested",
                details: {
                  from: "jane@example.com",
                  to: "jane.new@example.com",
                  resend: true,
                },
              },
            },
            {
              id: 1,
              occurredAt: "2026-03-01T10:00:00+00:00",
              event: {
                type: "email.change_requested",
                details: {
                  from: "jane@example.com",
                  to: "jane.new@example.com",
                  resend: false,
                },
              },
            },
          ],
          nextCursor: null,
        }}
      />,
    );

    const items = events();
    expect(items[0]).toHaveAttribute("data-activity-event", "email.changed");
    expect(items[0]).toHaveTextContent("Email address changed");
    expect(items[0]).toHaveTextContent("Now jane.new@example.com.");
    expect(items[1]).toHaveTextContent("Email change confirmation resent");
    expect(items[2]).toHaveAttribute("data-activity-event", "email.change_requested");
    expect(items[2]).toHaveTextContent("Email change requested");
    expect(items[2]).toHaveTextContent("not in effect until confirmed");
  });

  it("shows an empty state — and no button — when nothing was recorded", () => {
    const { container } = renderList([], null);

    expect(container.querySelector("[data-activity-state]")).toHaveAttribute(
      "data-activity-state",
      "empty",
    );
    expect(screen.getByText(EMPTY_ACTIVITY_TEXT)).toBeVisible();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(loadOlderButton()).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not declare the history empty when this page held nothing but older entries exist", () => {
    const { container } = renderList([], CURSOR_1);

    expect(container.querySelector("[data-activity-state]")).toHaveAttribute(
      "data-activity-state",
      "list",
    );
    expect(
      container.querySelector('[data-activity-page="empty-with-more"]'),
    ).toHaveTextContent(EMPTY_PAGE_WITH_MORE_TEXT);
    expect(screen.queryByText(EMPTY_ACTIVITY_TEXT)).not.toBeInTheDocument();
    expect(loadOlderButton()).toBeEnabled();
  });

  it("REGRESSION: once paged to the end with nothing recognisable, it does not keep promising older activity", async () => {
    action.loadMoreAccountActivity.mockResolvedValue(ok(CURSOR_1, [], null));
    const { container } = renderList([], CURSOR_1);

    await loadOlder();

    expect(loadOlderButton()).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY_PAGE_WITH_MORE_TEXT)).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-activity-page="empty-at-end"]'),
    ).toHaveTextContent(NOTHING_TO_SHOW_TEXT);
    // Still not "no activity yet": the server said entries exist.
    expect(screen.queryByText(EMPTY_ACTIVITY_TEXT)).not.toBeInTheDocument();
    expect(status()).toHaveTextContent(END_OF_ACTIVITY_TEXT);
  });

  it("renders a day that recurs out of order without key collisions (order is never changed)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          entries: [
            { ...entry(3), occurredAt: "2026-03-02T10:00:00+00:00" },
            { ...entry(2), occurredAt: "2026-03-01T10:00:00+00:00" },
            { ...entry(1), occurredAt: "2026-03-02T09:00:00+00:00" },
          ],
          nextCursor: null,
        }}
      />,
    );

    expect(days().map((g) => g.getAttribute("data-activity-day"))).toEqual([
      "2026-03-02",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it("says the history is unavailable, offers a retry, and claims nothing about what happened", () => {
    const { container } = render(<AccountActivityCard initial={{ ok: false }} />);

    expect(container.querySelector("[data-activity-state]")).toHaveAttribute(
      "data-activity-state",
      "unavailable",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(UNAVAILABLE_ACTIVITY_TEXT);
    // A failed read says nothing about the account either way.
    expect(screen.getByRole("alert")).not.toHaveTextContent(/nothing has changed/i);
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY_ACTIVITY_TEXT)).not.toBeInTheDocument();
    expect(loadOlderButton()).not.toBeInTheDocument();
  });

  it("offers older entries only when there is a cursor, without claiming the end was just reached", () => {
    renderList([1], null);

    expect(loadOlderButton()).not.toBeInTheDocument();
    expect(screen.queryByText(END_OF_ACTIVITY_TEXT)).not.toBeInTheDocument();
    // The live region exists from the start (so later changes are announced) but says nothing yet.
    expect(status()).toHaveTextContent("");
    expect(status()).toHaveClass("sr-only");
  });

  it("derives its shape from the first page alone", () => {
    expect(accountActivityState({ ok: false })).toBe("unavailable");
    expect(accountActivityState({ ok: true, entries: [], nextCursor: null })).toBe(
      "empty",
    );
    expect(accountActivityState({ ok: true, entries: [], nextCursor: "x" })).toBe("list");
    expect(
      accountActivityState({ ok: true, entries: [entry(1)], nextCursor: null }),
    ).toBe("list");
  });
});

describe("AccountActivityCard – the timeline", () => {
  const at = (id: number, occurredAt: string): AccountActivityEntry => ({
    ...entry(id),
    occurredAt,
  });

  it("groups entries under the UTC day they happened, newest day first, keeping the order within a day", () => {
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          entries: [
            at(5, "2026-03-02T23:30:00+00:00"),
            at(4, "2026-03-02T08:00:00+00:00"),
            at(3, "2026-03-01T23:59:59+00:00"),
            at(2, "2026-03-01T00:00:00+00:00"),
            at(1, "2026-02-27T12:00:00+00:00"),
          ],
          nextCursor: null,
        }}
      />,
    );

    const groups = days();
    expect(groups.map((g) => g.getAttribute("data-activity-day"))).toEqual([
      "2026-03-02",
      "2026-03-01",
      "2026-02-27",
    ]);
    expect(
      groups.map((g) => within(g).getByRole("heading", { level: 4 }).textContent),
    ).toEqual(["2 Mar 2026", "1 Mar 2026", "27 Feb 2026"]);

    const perDay = groups.map((g) =>
      within(g)
        .getAllByRole("listitem")
        .filter((i) => i.hasAttribute("data-activity-event"))
        .map((i) => i.querySelector("time")!.textContent),
    );
    expect(perDay).toEqual([
      ["23:30 UTC", "08:00 UTC"],
      ["23:59 UTC", "00:00 UTC"],
      ["12:00 UTC"],
    ]);

    // Each day's entries are a list named after the day.
    expect(
      screen.getByRole("list", { name: "Activity on 2 Mar 2026" }),
    ).toBeInTheDocument();
  });

  it("groups by the UTC day, the zone every time on this page is shown in (a local-day split would not match the labels)", () => {
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          // 23:30 in UTC-2 is 01:30 UTC the next day.
          entries: [
            at(2, "2026-03-01T23:30:00-02:00"),
            at(1, "2026-03-01T10:00:00+00:00"),
          ],
          nextCursor: null,
        }}
      />,
    );

    expect(days().map((g) => g.getAttribute("data-activity-day"))).toEqual([
      "2026-03-02",
      "2026-03-01",
    ]);
  });

  it("gives every event type its own icon", () => {
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          entries: [
            {
              id: 5,
              occurredAt: "2026-03-01T10:05:00+00:00",
              event: { type: "email.changed", details: { to: "b@x.io" } },
            },
            {
              id: 4,
              occurredAt: "2026-03-01T10:04:00+00:00",
              event: {
                type: "email.change_requested",
                details: { from: "a@x.io", to: "b@x.io", resend: false },
              },
            },
            {
              id: 3,
              occurredAt: "2026-03-01T10:03:00+00:00",
              event: { type: "sessions.others_signed_out", details: {} },
            },
            {
              id: 2,
              occurredAt: "2026-03-01T10:02:00+00:00",
              event: {
                type: "password.changed",
                details: { otherSessionsSignedOut: true },
              },
            },
            entry(1),
          ],
          nextCursor: null,
        }}
      />,
    );

    const icons = events().map((item) =>
      item.querySelector("[data-activity-icon]")!.getAttribute("data-activity-icon"),
    );
    expect(icons).toEqual([
      "email-changed",
      "email-requested",
      "sessions",
      "password",
      "profile",
    ]);
    expect(new Set(icons).size).toBe(icons.length);
    // Decorative: the text carries the meaning.
    for (const item of events()) {
      expect(item.querySelector("[data-activity-icon]")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(item.querySelector("[data-activity-icon] svg")).toBeInTheDocument();
    }
  });

  it("has an icon for every event type in the catalogue", () => {
    expect(Object.keys(ACTIVITY_ICONS).sort()).toEqual(
      ACCOUNT_ACTIVITY_EVENT_SCHEMA.options.map((o) => o.shape.type.value).sort(),
    );
    const names = Object.values(ACTIVITY_ICONS).map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("links the nodes: every node but the last continues the line (across days too)", () => {
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          entries: [
            at(3, "2026-03-02T10:00:00+00:00"),
            at(2, "2026-03-01T11:00:00+00:00"),
            at(1, "2026-03-01T10:00:00+00:00"),
          ],
          nextCursor: null,
        }}
      />,
    );

    const connected = events().map((item) => /\bafter:w-px\b/.test(item.className));
    expect(connected).toEqual([true, true, false]);
    // Day labels sit on the line too: marker before, connector after.
    for (const group of days()) {
      const heading = within(group).getByRole("heading", { level: 4 });
      expect(heading.className).toMatch(/\bbefore:rounded-full\b/);
      expect(heading.className).toMatch(/\bafter:w-px\b/);
    }
  });

  it("puts an entry whose time cannot be read under 'Unknown date', without breaking the list", () => {
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          entries: [at(2, "2026-03-01T10:00:00+00:00"), at(1, "not a date")],
          nextCursor: null,
        }}
      />,
    );

    const groups = days();
    expect(groups[1]).toHaveAttribute("data-activity-day", "unknown");
    expect(within(groups[1]).getByRole("heading", { level: 4 })).toHaveTextContent(
      "Unknown date",
    );
    expect(events()[1]).toHaveTextContent("Unknown time");
    expect(events()[1].querySelector("time")).toBeNull();
  });

  it("stacks on a phone and puts the time beside the text from sm up (same breakpoint as the other cards)", () => {
    renderList([1], null);

    const node = events()[0];
    expect(node.className).toMatch(/\bflex-col\b/);
    expect(node.className).toMatch(/\bsm:flex-row\b/);
    expect(node.className).toMatch(/\bsm:justify-between\b/);
  });

  it("an older page that starts on the day the list ended on joins that day's group", async () => {
    action.loadMoreAccountActivity.mockResolvedValue({
      ok: true,
      cursor: CURSOR_1,
      entries: [at(2, "2026-03-01T09:00:00+00:00"), at(1, "2026-02-28T09:00:00+00:00")],
      nextCursor: null,
    });
    render(
      <AccountActivityCard
        initial={{
          ok: true,
          entries: [
            at(4, "2026-03-02T10:00:00+00:00"),
            at(3, "2026-03-01T10:00:00+00:00"),
          ],
          nextCursor: CURSOR_1,
        }}
      />,
    );

    await loadOlder();

    const groups = days();
    expect(groups.map((g) => g.getAttribute("data-activity-day"))).toEqual([
      "2026-03-02",
      "2026-03-01",
      "2026-02-28",
    ]);
    expect(
      within(groups[1])
        .getAllByRole("listitem")
        .filter((i) => i.hasAttribute("data-activity-event"))
        .map(
          (i) =>
            i.getAttribute("data-activity-event") && i.querySelector("time")!.textContent,
        ),
    ).toEqual(["10:00 UTC", "09:00 UTC"]);
    // The line now ends at the new last node.
    const connected = events().map((item) => /\bafter:w-px\b/.test(item.className));
    expect(connected).toEqual([true, true, true, false]);
  });
});

describe("AccountActivityCard – loading older entries", () => {
  it("appends the next page below the current one and keeps offering more while there is a cursor", async () => {
    action.loadMoreAccountActivity.mockResolvedValue(ok(CURSOR_1, [4, 3], CURSOR_2));
    renderList([6, 5], CURSOR_1);

    await loadOlder();

    expect(action.loadMoreAccountActivity).toHaveBeenCalledTimes(1);
    expect(action.loadMoreAccountActivity).toHaveBeenCalledWith(CURSOR_1);
    expect(shownDetails()).toEqual([
      "From “Old” to “Name 6”.",
      "From “Old” to “Name 5”.",
      "From “Old” to “Name 4”.",
      "From “Old” to “Name 3”.",
    ]);
    expect(loadOlderButton()).toBeEnabled();
    expect(status()).toHaveTextContent(loadedAnnouncement(2, 4));
    expect(status()).not.toHaveClass("sr-only");
  });

  it("asks for the page after the last one loaded, not the first cursor again", async () => {
    action.loadMoreAccountActivity
      .mockResolvedValueOnce(ok(CURSOR_1, [4, 3], CURSOR_2))
      .mockResolvedValueOnce(ok(CURSOR_2, [2], null));
    renderList([6, 5], CURSOR_1);

    await loadOlder();
    await loadOlder();

    expect(action.loadMoreAccountActivity.mock.calls).toEqual([[CURSOR_1], [CURSOR_2]]);
    expect(shownDetails()).toHaveLength(5);
  });

  it("marks the end: the button goes, the live region says so and takes focus", async () => {
    action.loadMoreAccountActivity.mockResolvedValue(ok(CURSOR_1, [4], null));
    renderList([6, 5], CURSOR_1);

    await loadOlder();

    expect(loadOlderButton()).not.toBeInTheDocument();
    expect(status()).toHaveTextContent(END_OF_ACTIVITY_TEXT);
    expect(status()).toHaveTextContent(loadedAnnouncement(1, 3));
    await waitFor(() => expect(status()).toHaveFocus());
  });

  it("is busy, not disabled, while a page loads, and ignores further clicks meanwhile", async () => {
    const request = deferred<LoadMoreAccountActivityResult>();
    action.loadMoreAccountActivity.mockReturnValue(request.promise);
    renderList([6, 5], CURSOR_1);

    const button = loadOlderButton()!;
    await userEvent.click(button);

    const pendingButton = screen.getByRole("button", { name: LOAD_OLDER_PENDING_LABEL });
    expect(pendingButton).toHaveAttribute("aria-disabled", "true");
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(pendingButton).not.toBeDisabled();
    expect(status()).toHaveTextContent(LOAD_OLDER_PENDING_LABEL);

    await userEvent.click(pendingButton);
    await userEvent.click(pendingButton);
    expect(action.loadMoreAccountActivity).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve(ok(CURSOR_1, [4], null));
      await request.promise;
    });
    expect(shownDetails()).toHaveLength(3);
  });

  it("never shows an entry twice, even if a response overlaps what is already shown", async () => {
    action.loadMoreAccountActivity.mockResolvedValue(ok(CURSOR_1, [5, 4], null));
    renderList([6, 5], CURSOR_1);

    await loadOlder();

    expect(shownDetails()).toEqual([
      "From “Old” to “Name 6”.",
      "From “Old” to “Name 5”.",
      "From “Old” to “Name 4”.",
    ]);
    expect(status()).toHaveTextContent(loadedAnnouncement(1, 3));
  });

  it("announces in plain English (one entry / several entries)", () => {
    expect(loadedAnnouncement(1, 1)).toBe("Loaded 1 older entry. 1 entry shown.");
    expect(loadedAnnouncement(2, 3)).toBe("Loaded 2 older entries. 3 entries shown.");
    expect(loadedAnnouncement(0, 3)).toBe("No new entries. 3 entries shown.");
    expect(loadedAnnouncement(2, 3)).not.toMatch(/entrys/);
  });

  it("appends by id", () => {
    const current = [entry(6), entry(5)];

    expect(appendEntries(current, [entry(5), entry(4)])).toEqual([
      entry(6),
      entry(5),
      entry(4),
    ]);
    expect(appendEntries(current, [entry(5)])).toBe(current); // nothing new: same array
    expect(appendEntries(current, [])).toBe(current);
  });

  it("ignores a response that answers a cursor it is not waiting on, and lets the user try again", async () => {
    action.loadMoreAccountActivity.mockResolvedValue(ok("some-other-cursor", [4], null));
    renderList([6, 5], CURSOR_1);

    await loadOlder();

    expect(shownDetails()).toHaveLength(2);
    expect(loadOlderButton()).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(LOAD_MORE_ACTIVITY_COPY.retry);
  });

  describe("failures keep what is on screen", () => {
    it("shows the action's message and offers the same page again", async () => {
      action.loadMoreAccountActivity
        .mockResolvedValueOnce(failed(CURSOR_1))
        .mockResolvedValueOnce(ok(CURSOR_1, [4], null));
      renderList([6, 5], CURSOR_1);

      await loadOlder();

      expect(screen.getByRole("alert")).toHaveTextContent(LOAD_MORE_ACTIVITY_COPY.retry);
      expect(shownDetails()).toHaveLength(2);
      expect(loadOlderButton()).toBeEnabled();

      await loadOlder();

      expect(action.loadMoreAccountActivity.mock.calls).toEqual([[CURSOR_1], [CURSOR_1]]);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(shownDetails()).toHaveLength(3);
    });

    it("asks for a reload when the cursor is no longer valid — and offers it instead of a pointless retry", async () => {
      action.loadMoreAccountActivity.mockResolvedValue(failed(CURSOR_1, true));
      renderList([6, 5], CURSOR_1);

      await loadOlder();

      expect(screen.getByRole("alert")).toHaveTextContent(
        LOAD_MORE_ACTIVITY_COPY.restart,
      );
      expect(shownDetails()).toHaveLength(2); // what was on screen stays
      expect(loadOlderButton()).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: RELOAD_LABEL })).toHaveAttribute(
        "href",
        "/settings",
      );
      expect(action.loadMoreAccountActivity).toHaveBeenCalledTimes(1);
    });

    it("treats a rejected action (network, server crash) as a retryable failure", async () => {
      action.loadMoreAccountActivity.mockRejectedValue(new Error("fetch failed"));
      renderList([6, 5], CURSOR_1);

      await loadOlder();

      expect(screen.getByRole("alert")).toHaveTextContent(LOAD_MORE_ACTIVITY_COPY.retry);
      expect(shownDetails()).toHaveLength(2);
      expect(loadOlderButton()).toBeEnabled();
    });

    it("clears a previous failure as soon as a new attempt starts", async () => {
      const request = deferred<LoadMoreAccountActivityResult>();
      action.loadMoreAccountActivity
        .mockResolvedValueOnce(failed(CURSOR_1))
        .mockReturnValueOnce(request.promise);
      renderList([6, 5], CURSOR_1);

      await loadOlder();
      expect(screen.getByRole("alert")).toBeInTheDocument();

      await userEvent.click(loadOlderButton()!);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await act(async () => {
        request.resolve(ok(CURSOR_1, [4], null));
        await request.promise;
      });
    });
  });
});

describe("AccountActivityCard – staying current after a change (the page re-renders with a new first page)", () => {
  const page = (ids: number[], nextCursor: string | null) => ({
    ok: true as const,
    entries: ids.map((id) => entry(id)),
    nextCursor,
  });

  it("REGRESSION: a second change shows up without a reload, with the list already mounted", () => {
    const { rerender } = render(<AccountActivityCard initial={page([1], null)} />);
    expect(shownDetails()).toEqual(["From “Old” to “Name 1”."]);

    // First change: the action revalidated the route; the server sent a new first page.
    rerender(<AccountActivityCard initial={page([2, 1], null)} />);
    expect(shownDetails()).toEqual([
      "From “Old” to “Name 2”.",
      "From “Old” to “Name 1”.",
    ]);

    // Second change, same thing — this is the case that used to need a reload.
    rerender(<AccountActivityCard initial={page([3, 2, 1], null)} />);
    expect(shownDetails()).toEqual([
      "From “Old” to “Name 3”.",
      "From “Old” to “Name 2”.",
      "From “Old” to “Name 1”.",
    ]);
  });

  it("goes from empty to listing on the first change", () => {
    const { rerender, container } = render(
      <AccountActivityCard initial={page([], null)} />,
    );
    expect(screen.getByText(EMPTY_ACTIVITY_TEXT)).toBeVisible();

    rerender(<AccountActivityCard initial={page([1], null)} />);

    expect(container.querySelector("[data-activity-state]")).toHaveAttribute(
      "data-activity-state",
      "list",
    );
    expect(shownDetails()).toEqual(["From “Old” to “Name 1”."]);
    expect(screen.queryByText(EMPTY_ACTIVITY_TEXT)).not.toBeInTheDocument();
  });

  it("a new first page replaces older pages that were loaded (they can be loaded again)", async () => {
    action.loadMoreAccountActivity.mockResolvedValue(ok(CURSOR_1, [4, 3], null));
    const { rerender } = render(<AccountActivityCard initial={page([6, 5], CURSOR_1)} />);

    await loadOlder();
    expect(shownDetails()).toHaveLength(4);
    expect(loadOlderButton()).not.toBeInTheDocument();

    rerender(<AccountActivityCard initial={page([7, 6], "cursor-after-6")} />);

    expect(shownDetails()).toEqual([
      "From “Old” to “Name 7”.",
      "From “Old” to “Name 6”.",
    ]);
    expect(loadOlderButton()).toBeEnabled();
    expect(status()).toHaveTextContent("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a re-render with the SAME first page leaves loaded pages and status alone", async () => {
    action.loadMoreAccountActivity.mockResolvedValue(ok(CURSOR_1, [4, 3], null));
    const { rerender } = render(<AccountActivityCard initial={page([6, 5], CURSOR_1)} />);

    await loadOlder();
    expect(shownDetails()).toHaveLength(4);

    // Same content, fresh objects — what a re-render of the server page delivers
    // when nothing was recorded (e.g. the name was saved unchanged).
    rerender(<AccountActivityCard initial={page([6, 5], CURSOR_1)} />);

    expect(shownDetails()).toHaveLength(4);
    expect(status()).toHaveTextContent(END_OF_ACTIVITY_TEXT);
  });

  it("identifies a first page by its entries and its cursor", () => {
    expect(firstPageKey([entry(2), entry(1)], "c")).toBe(
      firstPageKey([entry(2), entry(1)], "c"),
    );
    expect(firstPageKey([entry(2), entry(1)], "c")).not.toBe(
      firstPageKey([entry(3), entry(2)], "c"),
    );
    expect(firstPageKey([entry(2), entry(1)], "c")).not.toBe(
      firstPageKey([entry(2), entry(1)], null),
    );
    expect(firstPageKey([], null)).not.toBe(firstPageKey([], "c"));
  });
});
