/**
 * The support page's flow end to end, short of the network: the real form,
 * the real history list, both real Server Actions and both real services.
 * Two things stand in for infrastructure:
 *
 * - an in-memory table behind a fake Supabase client, which implements what
 *   the services ask PostgREST for (insert, owner filter, keyset cursor,
 *   ordering, limit) — and holds another user's rows, to prove isolation;
 * - Next's revalidation: `revalidatePath("/support")` re-runs the server
 *   section's read and hands the result to the history, as the router does
 *   when the route is re-rendered;
 * - the session: `session.state` says whether the user is signed in. When it
 *   has ended, the session lookup finds no user and the database refuses the
 *   request (as PostgREST does without a valid JWT: 42501).
 *
 * Nothing on the page may navigate — a navigation would take an unsent draft
 * with it — so the router and `redirect` fail every test that touches them.
 * Where a navigation is simulated on purpose (the safety net), the page is
 * unmounted and mounted again, as leaving and coming back would do.
 *
 * The database's own rules (RLS, constraints) are proven against PostgreSQL
 * in `support-requests.integration.test.ts`; this file proves the page.
 */
import { useEffect, useState } from "react";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type FakeQuery, OK_RESPONSE } from "@/shared/test/supabase";

// --- infrastructure stand-ins --------------------------------------------------

const server = vi.hoisted(() => ({
  /** Re-renders the history from the database, like a route refresh. */
  refresh: async () => {},
  /** The latest refresh, so a test can wait for it. */
  pending: Promise.resolve() as Promise<unknown>,
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn((path: string) => {
    server.revalidated.push(path);
    server.pending = server.refresh();
  }),
}));

const navigation = vi.hoisted(() => ({
  used: vi.fn((what: string) => {
    throw new Error(`the support page must not navigate (${what})`);
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => navigation.used(`redirect to ${url}`),
  useRouter: () => ({
    push: () => navigation.used("push"),
    replace: () => navigation.used("replace"),
    refresh: () => navigation.used("refresh"),
    back: () => navigation.used("back"),
  }),
}));

const session = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
}));
vi.mock("@/infrastructure/auth/session/get-current-user", () => session);

const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("the support page must never use the service role");
  }),
}));

import {
  listSupportRequests,
  type ListSupportRequestsResult,
  SUPPORT_REQUESTS_DEFAULT_LIMIT,
} from "../services/list-support-requests";
import { SUPPORT_REQUEST_FIELD_ERRORS } from "../services/support-request";
import {
  SUPPORT_REQUEST_CATEGORY_LABELS,
  SUPPORT_REQUEST_FORM_COPY as FORM,
} from "../services/support-request-copy";
import { SUPPORT_REQUEST_ERRORS } from "../services/support-request-errors";
import { SUPPORT_HISTORY_COPY as HISTORY } from "../services/support-request-history";

import { SUPPORT_REQUEST_DRAFT, SupportRequestForm } from "./support-request-form";
import { SupportRequestHistory } from "./support-request-history";

// --- the in-memory table ---------------------------------------------------------

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

type Row = {
  id: string;
  user_id: string;
  category: string;
  subject: string;
  message: string;
  status: string;
  created_at: string;
};

/** Whether the user's session is still valid. */
const sessionState = { signedIn: true };

const table = {
  rows: [] as Row[],
  /** Monotonic clock for created_at; one minute per request. */
  clock: Date.parse("2026-03-01T10:00:00Z"),
  serial: 0,
  /** Make the next reads fail (an outage). */
  failReads: false,
};

function insertRow(
  userId: string,
  fields: Pick<Row, "category" | "subject" | "message">,
) {
  table.serial += 1;
  table.clock += 60_000;
  const row: Row = {
    id: `00000000-0000-4000-8000-${table.serial.toString(16).padStart(12, "0")}`,
    user_id: userId,
    status: "open",
    created_at: new Date(table.clock).toISOString(),
    ...fields,
  };
  table.rows.push(row);
  return row;
}

/** The columns the services select (never `user_id`). */
const project = (row: Row) => ({
  id: row.id,
  created_at: row.created_at,
  category: row.category,
  status: row.status,
  subject: row.subject,
  message: row.message,
});

/** What PostgREST would answer, for the queries these services send. */
function respond(query: FakeQuery) {
  const call = (method: string) => query.calls.find((c) => c.method === method)?.args;

  // Without a valid session PostgREST runs as `anon`, which may do nothing.
  if (!sessionState.signedIn) {
    return {
      ...OK_RESPONSE,
      status: 401,
      data: null,
      error: { message: "permission denied for table support_requests", code: "42501" },
    };
  }

  // RLS: the session's user is the only one whose rows exist for this client.
  const sessionUser = currentUser;

  const insert = call("insert");
  if (insert) {
    const row = insertRow(sessionUser, insert[0] as Row);
    return { ...OK_RESPONSE, status: 201, data: project(row) };
  }

  if (table.failReads) {
    return {
      ...OK_RESPONSE,
      status: 503,
      data: null,
      error: { message: "unavailable", code: "57P03" },
    };
  }

  const [, owner] = call("eq") as [string, string];
  const cursor = (call("or")?.[0] as string | undefined)?.match(
    /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/,
  );
  const [limit] = call("limit") as [number];

  const rows = table.rows
    .filter((r) => r.user_id === sessionUser && r.user_id === owner)
    .filter((r) => {
      if (!cursor) return true;
      const t = Date.parse(cursor[1]);
      const at = Date.parse(r.created_at);
      return at < t || (at === t && r.id < cursor[3]);
    })
    .sort((a, b) =>
      a.created_at === b.created_at
        ? b.id.localeCompare(a.id)
        : Date.parse(b.created_at) - Date.parse(a.created_at),
    )
    .slice(0, limit)
    .map(project);

  return { ...OK_RESPONSE, status: 200, data: rows };
}

let currentUser = ALICE;

// --- the page, as Next would assemble it ----------------------------------------

/** The server section's read (SupportRequestHistorySection). */
const readFirstPage = () =>
  listSupportRequests(currentUser, { limit: SUPPORT_REQUESTS_DEFAULT_LIMIT });

/**
 * What the server renders for a request: the page belongs to whoever holds
 * the session at that moment, and that account is fixed into the render —
 * exactly like `page.tsx`, which reads the user once and passes it down (and
 * keys the form and the list by it). Client re-renders never change it; only
 * a server render (here: `server.refresh`, i.e. revalidation) does.
 */
type Rendered = { owner: string; first: ListSupportRequestsResult };

const renderForSession = async (): Promise<Rendered> => ({
  owner: currentUser,
  first: await readFirstPage(),
});

function SupportPage({ rendered }: { rendered: Rendered }) {
  const [current, setCurrent] = useState(rendered);

  useEffect(() => {
    server.refresh = async () => setCurrent(await renderForSession());
  }, []);

  // Keys as on the real page: the form is keyed among the page's children,
  // the history inside its own section (different parents, so no clash).
  return (
    <>
      <SupportRequestForm key={current.owner} ownerId={current.owner} />
      <section>
        <SupportRequestHistory
          key={current.owner}
          ownerId={current.owner}
          initial={current.first}
        />
      </section>
    </>
  );
}

async function renderPage() {
  const user = userEvent.setup();
  const view = render(<SupportPage rendered={await renderForSession()} />);
  return Object.assign(user, { unmountPage: view.unmount });
}

// --- helpers ----------------------------------------------------------------------

const history = () => screen.getByRole("region", { name: HISTORY.title });
const shownSubjects = () =>
  within(history())
    .queryAllByRole("heading", { level: 4 })
    .map((h) => h.textContent);
const subjectInput = () => screen.getByLabelText(FORM.subjectLabel);
const messageInput = () => screen.getByLabelText(FORM.messageLabel);

async function sendRequest(
  user: ReturnType<typeof userEvent.setup>,
  subject: string,
  message = "Some details.",
) {
  await user.click(
    screen.getByRole("radio", { name: SUPPORT_REQUEST_CATEGORY_LABELS.technical }),
  );
  // `clear` first: user-event keeps its own copy of a field's value, updated
  // through the `value` setter, and the form's native `reset()` after a
  // success bypasses that setter — so without it, user-event would append to
  // the previous (already cleared) text. Browsers have no such copy.
  await user.clear(subjectInput());
  await user.type(subjectInput(), subject);
  await user.clear(messageInput());
  await user.type(messageInput(), message);
  await user.click(screen.getByRole("button", { name: FORM.submit }));
}

/**
 * Waits for the form's own outcome: the confirmation, and the cleared fields.
 * In Next the refreshed history and the action's result arrive in one
 * response and commit together; this harness refreshes the history while the
 * action is still finishing, so the list can update a moment before the form
 * does. Tests therefore never infer the form's state from the list.
 */
async function formConfirmed() {
  expect(await screen.findByText(/has been sent/)).toBeInTheDocument();
  await waitFor(() => expect(subjectInput()).toHaveValue(""));
}

function seed(userId: string, count: number, prefix: string) {
  for (let i = 1; i <= count; i++) {
    insertRow(userId, {
      category: "billing",
      subject: `${prefix} ${i}`,
      message: "Seeded.",
    });
  }
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  table.rows = [];
  table.serial = 0;
  table.clock = Date.parse("2026-03-01T10:00:00Z");
  table.failReads = false;
  server.revalidated = [];
  server.pending = Promise.resolve();
  currentUser = ALICE;
  sessionState.signedIn = true;
  navigation.used.mockClear();

  session.getCurrentUser.mockImplementation(async () =>
    sessionState.signedIn ? { id: currentUser } : null,
  );
  infra.createClient.mockImplementation(async () => createFakeSupabase(respond).client);
  // The app logs its own failures ("[support] …"); anything else — a React
  // warning such as a duplicate key or an act() problem — fails the test.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  expect(navigation.used).not.toHaveBeenCalled();
  const unexpected = [
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ].filter(([first]) => !(typeof first === "string" && first.startsWith("[support]")));
  expect(unexpected, "unexpected console output (React warnings?)").toEqual([]);
  vi.restoreAllMocks();
});

// --- the flow ---------------------------------------------------------------------

describe("the history", () => {
  it("shows only the signed-in user's requests, newest first, a page at a time", async () => {
    seed(ALICE, 12, "Alice");
    seed(BOB, 3, "Bob"); // newer than all of Alice's: must never appear
    const user = await renderPage();

    expect(shownSubjects()).toEqual([
      "Alice 12",
      "Alice 11",
      "Alice 10",
      "Alice 9",
      "Alice 8",
      "Alice 7",
      "Alice 6",
      "Alice 5",
      "Alice 4",
      "Alice 3",
    ]);

    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));

    await waitFor(() => expect(shownSubjects()).toHaveLength(12));
    expect(shownSubjects().slice(-2)).toEqual(["Alice 2", "Alice 1"]);
    expect(history()).toHaveTextContent(HISTORY.end);
    expect(
      screen.queryByRole("button", { name: HISTORY.loadOlder }),
    ).not.toBeInTheDocument();
    expect(history()).not.toHaveTextContent("Bob");
  });

  it("has an empty state for a user who has sent nothing (whatever others have sent)", async () => {
    seed(BOB, 3, "Bob");
    await renderPage();

    expect(history()).toHaveAttribute("data-history-state", "empty");
    expect(history()).toHaveTextContent(HISTORY.empty);
  });
});

describe("sending a request", () => {
  it("the first request ever replaces the empty state", async () => {
    const user = await renderPage();
    expect(history()).toHaveAttribute("data-history-state", "empty");

    await sendRequest(user, "My very first request");

    await waitFor(() => expect(shownSubjects()).toEqual(["My very first request"]));
    expect(history()).toHaveAttribute("data-history-state", "list");
    expect(server.revalidated).toEqual(["/support"]);

    // The form confirmed and cleared for the next one.
    await formConfirmed();
  });

  it("a new request appears at the top of an existing history", async () => {
    seed(ALICE, 3, "Older");
    const user = await renderPage();

    await sendRequest(user, "Just sent");

    await waitFor(() =>
      expect(shownSubjects()).toEqual(["Just sent", "Older 3", "Older 2", "Older 1"]),
    );
    const item = within(history()).getByRole("article", { name: "Just sent" });
    expect(item).toHaveTextContent("Open");
    expect(item).toHaveTextContent(SUPPORT_REQUEST_CATEGORY_LABELS.technical);
  });

  it("after paging back, a new request still appears at the top (the list restarts from page one)", async () => {
    seed(ALICE, 12, "Older");
    const user = await renderPage();

    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));
    await waitFor(() => expect(shownSubjects()).toHaveLength(12));

    await sendRequest(user, "Sent after paging");

    await waitFor(() => expect(shownSubjects()[0]).toBe("Sent after paging"));
    expect(shownSubjects()).toHaveLength(SUPPORT_REQUESTS_DEFAULT_LIMIT);
    // Older pages can be loaded again, and paging continues correctly: every
    // request exactly once.
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));
    await waitFor(() => expect(shownSubjects()).toHaveLength(13));
    expect(new Set(shownSubjects()).size).toBe(13);
  });

  it("several requests in a row each appear, newest first", async () => {
    const user = await renderPage();

    await sendRequest(user, "One");
    await waitFor(() => expect(shownSubjects()).toEqual(["One"]));
    await formConfirmed();

    await sendRequest(user, "Two");
    await waitFor(() => expect(shownSubjects()).toEqual(["Two", "One"]));
  });

  it("a rejected request does not appear, and the history is not reloaded", async () => {
    seed(ALICE, 2, "Older");
    const user = await renderPage();

    // Spaces pass the browser's `required`, not the server's validation.
    await sendRequest(user, "   ");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
    );
    expect(server.revalidated).toEqual([]);
    expect(shownSubjects()).toEqual(["Older 2", "Older 1"]);
    expect(table.rows).toHaveLength(2);
  });
});

describe("when the history cannot be read", () => {
  it("says so, and a retry brings the list — without touching a draft in the form", async () => {
    seed(ALICE, 2, "Older");
    table.failReads = true;
    const user = await renderPage();

    expect(history()).toHaveAttribute("data-history-state", "unavailable");
    expect(within(history()).getByRole("alert")).toHaveTextContent(HISTORY.unavailable);

    // The user is half-way through a request when they retry the list.
    await user.type(subjectInput(), "Draft subject");
    await user.type(messageInput(), "Draft message");

    table.failReads = false;
    await user.click(screen.getByRole("button", { name: HISTORY.retry }));

    await waitFor(() => expect(shownSubjects()).toEqual(["Older 2", "Older 1"]));
    expect(subjectInput()).toHaveValue("Draft subject");
    expect(messageInput()).toHaveValue("Draft message");
  });

  it("the form still works while the history is unavailable", async () => {
    table.failReads = true;
    const user = await renderPage();

    await sendRequest(user, "Sent during an outage");

    await formConfirmed();
    expect(table.rows.map((r) => r.subject)).toEqual(["Sent during an outage"]);
    // The history honestly stays unavailable until it can be read.
    await server.pending;
    expect(history()).toHaveAttribute("data-history-state", "unavailable");
  });

  it("a failed 'load older' keeps what is shown and can be retried", async () => {
    seed(ALICE, 12, "Older");
    const user = await renderPage();

    table.failReads = true;
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));

    expect(await within(history()).findByRole("alert")).toBeInTheDocument();
    expect(shownSubjects()).toHaveLength(10);

    table.failReads = false;
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));

    await waitFor(() => expect(shownSubjects()).toHaveLength(12));
    expect(within(history()).queryByRole("alert")).not.toBeInTheDocument();
  });
});

// --- session expiry with an unsent draft ---------------------------------------

const DRAFT = { subject: "Half-written subject", message: "A long, careful message." };

/** Types a request without sending it. */
async function typeDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("radio", { name: SUPPORT_REQUEST_CATEGORY_LABELS.technical }),
  );
  await user.type(subjectInput(), DRAFT.subject);
  await user.type(messageInput(), DRAFT.message);
}

/** Types and picks a category for a request with the given subject, without sending. */
async function typeDraftAs(user: ReturnType<typeof userEvent.setup>, subject: string) {
  await user.click(
    screen.getByRole("radio", { name: SUPPORT_REQUEST_CATEGORY_LABELS.technical }),
  );
  await user.clear(subjectInput());
  await user.type(subjectInput(), subject);
  await user.clear(messageInput());
  await user.type(messageInput(), "Details.");
}

function expectDraftOnScreen() {
  expect(
    screen.getByRole("radio", { name: SUPPORT_REQUEST_CATEGORY_LABELS.technical }),
  ).toBeChecked();
  expect(subjectInput()).toHaveValue(DRAFT.subject);
  expect(messageInput()).toHaveValue(DRAFT.message);
}

const storedDraft = (owner = ALICE) => {
  const raw = sessionStorage.getItem(`draft:${SUPPORT_REQUEST_DRAFT}:${owner}`);
  return raw === null ? null : JSON.parse(raw);
};

const signInLinkIn = (element: HTMLElement) =>
  within(element).getByRole("link", { name: HISTORY.signInAgain });

describe("an ended session never costs the user their draft", () => {
  it("'Load older': explains in place, keeps the draft, and works once signed in again", async () => {
    seed(ALICE, 12, "Older");
    const user = await renderPage();
    await typeDraft(user);

    sessionState.signedIn = false;
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));

    const alert = await within(history()).findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.listSessionExpired);
    expect(signInLinkIn(alert)).toHaveAttribute("target", "_blank");
    expect(shownSubjects()).toHaveLength(10);
    expectDraftOnScreen();

    // Signed in again in the other tab; the same button now works.
    sessionState.signedIn = true;
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));

    await waitFor(() => expect(shownSubjects()).toHaveLength(12));
    expectDraftOnScreen();

    // And the draft goes out as written.
    await user.click(screen.getByRole("button", { name: FORM.submit }));
    await formConfirmed();
    await waitFor(() => expect(shownSubjects()[0]).toBe(DRAFT.subject));
    expect(table.rows.at(-1)).toMatchObject({
      user_id: ALICE,
      category: "technical",
      subject: DRAFT.subject,
      message: DRAFT.message,
    });
    expect(storedDraft()).toBeNull();
  });

  it("'Try again': explains in place, keeps the draft, and loads the history once signed in", async () => {
    seed(ALICE, 2, "Older");
    table.failReads = true;
    const user = await renderPage();
    expect(history()).toHaveAttribute("data-history-state", "unavailable");
    await typeDraft(user);

    table.failReads = false;
    sessionState.signedIn = false;
    await user.click(screen.getByRole("button", { name: HISTORY.retry }));

    const alert = await within(history()).findByText(
      SUPPORT_REQUEST_ERRORS.listSessionExpired,
    );
    expect(signInLinkIn(history())).toHaveAttribute("target", "_blank");
    expect(alert).toBeInTheDocument();
    expectDraftOnScreen();

    sessionState.signedIn = true;
    await user.click(screen.getByRole("button", { name: HISTORY.retry }));

    await waitFor(() => expect(shownSubjects()).toEqual(["Older 2", "Older 1"]));
    expectDraftOnScreen();
  });

  it("a history first rendered with an ended session offers sign-in, not an outage", async () => {
    seed(ALICE, 1, "Older");
    sessionState.signedIn = false;
    const user = await renderPage();

    expect(within(history()).getByRole("alert")).toHaveTextContent(
      SUPPORT_REQUEST_ERRORS.listSessionExpired,
    );
    await typeDraft(user);

    sessionState.signedIn = true;
    await user.click(screen.getByRole("button", { name: HISTORY.retry }));

    await waitFor(() => expect(shownSubjects()).toEqual(["Older 1"]));
    expectDraftOnScreen();
  });

  it("sending: keeps the draft on screen and in the tab, and it goes out once signed in", async () => {
    const user = await renderPage();
    await typeDraft(user);

    sessionState.signedIn = false;
    await user.click(screen.getByRole("button", { name: FORM.submit }));

    const alert = await screen.findByText(SUPPORT_REQUEST_ERRORS.sessionExpired);
    expect(alert).toBeInTheDocument();
    expectDraftOnScreen();
    expect(storedDraft()).toMatchObject(DRAFT);
    expect(table.rows).toHaveLength(0);
    expect(server.revalidated).toEqual([]);

    sessionState.signedIn = true;
    await user.click(screen.getByRole("button", { name: FORM.submit }));

    await formConfirmed();
    await waitFor(() => expect(shownSubjects()).toEqual([DRAFT.subject]));
    expect(storedDraft()).toBeNull();
  });

  it("several expiries in a row: the draft survives every one", async () => {
    seed(ALICE, 12, "Older");
    table.failReads = false;
    const user = await renderPage();
    await typeDraft(user);

    sessionState.signedIn = false;
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));
    await within(history()).findByRole("alert");
    await user.click(screen.getByRole("button", { name: FORM.submit }));
    await screen.findByText(SUPPORT_REQUEST_ERRORS.sessionExpired);
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));
    await within(history()).findByRole("alert");

    expectDraftOnScreen();
    expect(storedDraft()).toMatchObject(DRAFT);
  });
});

describe("the safety net: if the page is left anyway, the draft comes back", () => {
  it("after being sent to sign in, coming back in the same tab restores the draft", async () => {
    seed(ALICE, 1, "Older");
    let user = await renderPage();
    await typeDraft(user);

    // Something navigates away (e.g. the layout's guard on a route re-render).
    sessionState.signedIn = false;
    user.unmountPage();

    // Signed in again; back on the support page in the same tab.
    sessionState.signedIn = true;
    user = await renderPage();

    expectDraftOnScreen();
    const form = screen.getByRole("form", { name: FORM.title });
    expect(within(form).getByRole("status")).toHaveTextContent(FORM.draftRestored);

    await user.click(screen.getByRole("button", { name: FORM.submit }));

    await formConfirmed();
    await waitFor(() => expect(shownSubjects()).toEqual([DRAFT.subject, "Older 1"]));
    expect(storedDraft()).toBeNull();
    expect(screen.queryByText(FORM.draftRestored)).not.toBeInTheDocument();
  });

  it("someone else signing in in the same tab never sees the draft, and it is removed", async () => {
    const user = await renderPage();
    await typeDraft(user);
    user.unmountPage();

    currentUser = BOB;
    await renderPage();

    expect(subjectInput()).toHaveValue("");
    expect(messageInput()).toHaveValue("");
    expect(screen.queryByText(FORM.draftRestored)).not.toBeInTheDocument();
    expect(storedDraft(ALICE)).toBeNull();
  });

  it("once sent, coming back starts from an empty form", async () => {
    let user = await renderPage();
    await typeDraft(user);
    await user.click(screen.getByRole("button", { name: FORM.submit }));
    await formConfirmed();
    user.unmountPage();

    user = await renderPage();

    expect(subjectInput()).toHaveValue("");
    expect(screen.queryByText(FORM.draftRestored)).not.toBeInTheDocument();
  });
});

// --- switching accounts while the page is open -----------------------------------

/** Someone signs in as `userId` in another tab: the shared session changes hands. */
function switchSessionTo(userId: string) {
  currentUser = userId;
  sessionState.signedIn = true;
}

const rowsOf = (userId: string) => table.rows.filter((r) => r.user_id === userId);

/** Nothing of Bob's is anywhere in what the page shows. */
function expectNoneOfBobsRequestsShown() {
  expect(history().textContent).not.toMatch(/Bob/);
}

describe("switching accounts while the page is open", () => {
  it("Alice's unsent request is never filed under Bob", async () => {
    seed(ALICE, 2, "Alice");
    seed(BOB, 2, "Bob");
    const user = await renderPage();
    await typeDraft(user);

    switchSessionTo(BOB);
    await user.click(screen.getByRole("button", { name: FORM.submit }));

    const alert = await screen.findByText(SUPPORT_REQUEST_ERRORS.accountChanged);
    expect(alert).toBeInTheDocument();
    expect(
      within(screen.getByRole("form", { name: FORM.title })).getByRole("link", {
        name: FORM.signInAgain,
      }),
    ).toHaveAttribute("target", "_blank");

    // Nothing was written for anyone, nothing was revalidated.
    expect(rowsOf(BOB)).toHaveLength(2);
    expect(rowsOf(ALICE)).toHaveLength(2);
    expect(server.revalidated).toEqual([]);

    // The text stays here for its author, kept under HER account only.
    expectDraftOnScreen();
    expect(storedDraft(ALICE)).toMatchObject(DRAFT);
    expect(storedDraft(BOB)).toBeNull();
  });

  it("once Alice signs back in, the same request goes out — under Alice", async () => {
    seed(BOB, 1, "Bob");
    const user = await renderPage();
    await typeDraft(user);

    switchSessionTo(BOB);
    await user.click(screen.getByRole("button", { name: FORM.submit }));
    await screen.findByText(SUPPORT_REQUEST_ERRORS.accountChanged);

    switchSessionTo(ALICE);
    await user.click(screen.getByRole("button", { name: FORM.submit }));

    await formConfirmed();
    expect(rowsOf(ALICE).map((r) => r.subject)).toEqual([DRAFT.subject]);
    expect(rowsOf(BOB).map((r) => r.subject)).toEqual(["Bob 1"]);
    await waitFor(() => expect(shownSubjects()).toEqual([DRAFT.subject]));
    expectNoneOfBobsRequestsShown();
  });

  it("an ended session, then Bob signing in through the link: still never filed under Bob", async () => {
    // The realistic path: Alice's session expires, the page offers "Sign in
    // again (opens a new tab)", and someone signs in there as Bob.
    const user = await renderPage();
    await typeDraft(user);

    sessionState.signedIn = false;
    await user.click(screen.getByRole("button", { name: FORM.submit }));
    await screen.findByText(SUPPORT_REQUEST_ERRORS.sessionExpired);

    switchSessionTo(BOB);
    await user.click(screen.getByRole("button", { name: FORM.submit }));

    await screen.findByText(SUPPORT_REQUEST_ERRORS.accountChanged);
    expect(table.rows).toHaveLength(0);
    expectDraftOnScreen();
  });

  it("'Load older' never adds Bob's requests to Alice's list", async () => {
    seed(ALICE, 12, "Alice");
    seed(BOB, 12, "Bob"); // all older-or-newer rows a position could match
    const user = await renderPage();
    expect(shownSubjects()).toHaveLength(10);

    switchSessionTo(BOB);
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));

    const alert = await within(history()).findByRole("alert");
    expect(alert).toHaveTextContent(SUPPORT_REQUEST_ERRORS.listAccountChanged);
    expect(
      within(alert).getByRole("link", { name: HISTORY.signInAgain }),
    ).toBeInTheDocument();
    expect(shownSubjects()).toHaveLength(10);
    expectNoneOfBobsRequestsShown();

    // Back to Alice: the same button loads HER older requests.
    switchSessionTo(ALICE);
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));

    await waitFor(() => expect(shownSubjects()).toHaveLength(12));
    expect(shownSubjects().every((s) => s?.startsWith("Alice"))).toBe(true);
  });

  it("'Try again' never shows Bob's requests in Alice's page", async () => {
    seed(ALICE, 2, "Alice");
    seed(BOB, 3, "Bob");
    table.failReads = true;
    const user = await renderPage();
    expect(history()).toHaveAttribute("data-history-state", "unavailable");

    table.failReads = false;
    switchSessionTo(BOB);
    await user.click(screen.getByRole("button", { name: HISTORY.retry }));

    expect(
      await within(history()).findByText(SUPPORT_REQUEST_ERRORS.listAccountChanged),
    ).toBeInTheDocument();
    expect(within(history()).queryByRole("list")).not.toBeInTheDocument();
    expectNoneOfBobsRequestsShown();

    switchSessionTo(ALICE);
    await user.click(screen.getByRole("button", { name: HISTORY.retry }));

    await waitFor(() => expect(shownSubjects()).toEqual(["Alice 2", "Alice 1"]));
  });

  it("if the page is re-rendered for Bob, it becomes wholly Bob's: no trace of Alice's draft", async () => {
    // E.g. Next re-renders the route after an action that touched cookies: the
    // server renders for whoever holds the session now. The form and list are
    // keyed by the account, so Bob gets fresh ones — Alice's text does not
    // stay in the fields (where Bob could have sent it as his own).
    seed(ALICE, 2, "Alice");
    seed(BOB, 1, "Bob");
    const user = await renderPage();
    await typeDraft(user);

    switchSessionTo(BOB);
    await act(() => server.refresh());

    // One page: one form, one history.
    expect(document.querySelectorAll("form")).toHaveLength(1);
    expect(document.querySelectorAll('[data-support-section="history"]')).toHaveLength(1);
    expect(subjectInput()).toHaveValue("");
    expect(messageInput()).toHaveValue("");
    expect(document.body.textContent).not.toContain(DRAFT.subject);
    expect(document.body.textContent).not.toContain(DRAFT.message);
    expect(screen.queryByText(FORM.draftRestored)).not.toBeInTheDocument();
    expect(storedDraft(ALICE)).toBeNull(); // not kept in a tab Bob now controls
    expect(shownSubjects()).toEqual(["Bob 1"]);

    // Bob's own request is his, and his page shows only his.
    await typeDraftAs(user, "Bob's own");
    await user.click(screen.getByRole("button", { name: FORM.submit }));

    await formConfirmed();
    expect(rowsOf(BOB).map((r) => r.subject)).toEqual(["Bob 1", "Bob's own"]);
    expect(rowsOf(ALICE)).toHaveLength(2);
    await waitFor(() => expect(shownSubjects()).toEqual(["Bob's own", "Bob 1"]));
  });

  it("a list Alice paged through is not carried over when the page becomes Bob's", async () => {
    seed(ALICE, 12, "Alice");
    seed(BOB, 1, "Bob");
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));
    await waitFor(() => expect(shownSubjects()).toHaveLength(12));

    switchSessionTo(BOB);
    await act(() => server.refresh());

    expect(shownSubjects()).toEqual(["Bob 1"]);
    expect(history().textContent).not.toMatch(/Alice/);
  });

  it("nothing is ever mixed, switching back and forth across several pages and a send", async () => {
    seed(ALICE, 25, "Alice");
    seed(BOB, 25, "Bob");
    const user = await renderPage();
    const loadOlder = () =>
      user.click(screen.getByRole("button", { name: HISTORY.loadOlder }));

    /** After every step: only Alice's requests, each once, newest first. */
    const expectAlicesList = (count: number) => {
      const shown = shownSubjects();
      expect(shown).toHaveLength(count);
      expect(new Set(shown).size).toBe(count);
      expect(shown).toEqual(Array.from({ length: count }, (_, i) => `Alice ${25 - i}`));
      expectNoneOfBobsRequestsShown();
    };
    const refused = async () => {
      expect(
        await within(history()).findByText(SUPPORT_REQUEST_ERRORS.listAccountChanged),
      ).toBeInTheDocument();
    };

    expectAlicesList(10);

    switchSessionTo(BOB);
    await loadOlder();
    await refused();
    expectAlicesList(10);

    switchSessionTo(ALICE);
    await loadOlder();
    await waitFor(() => expect(shownSubjects()).toHaveLength(20));
    expectAlicesList(20);

    switchSessionTo(BOB);
    await loadOlder();
    await refused();
    // Bob also tries to send from Alice's page: refused, nothing written.
    await typeDraftAs(user, "Sent from Alice's page");
    await user.click(screen.getByRole("button", { name: FORM.submit }));
    await screen.findByText(SUPPORT_REQUEST_ERRORS.accountChanged);
    expect(table.rows.some((r) => r.subject === "Sent from Alice's page")).toBe(false);
    expectAlicesList(20);

    switchSessionTo(ALICE);
    await loadOlder();
    await waitFor(() => expect(shownSubjects()).toHaveLength(25));
    expectAlicesList(25);
    expect(history()).toHaveTextContent(HISTORY.end);
    expect(rowsOf(ALICE)).toHaveLength(25);
    expect(rowsOf(BOB)).toHaveLength(25);
  });
});
