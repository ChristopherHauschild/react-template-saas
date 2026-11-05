// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type FakeQuery, OK_RESPONSE } from "@/shared/test/supabase";

// The cookie-based (user) client. Building the real one needs request cookies.
const infra = vi.hoisted(() => ({ createClient: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/infrastructure/auth/supabase/server", () => infra);

// Must never be touched: a request is filed as the user, never as the service
// role, so the database decides the owner and RLS applies.
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("filing a request must not use the service role");
  }),
}));

import { createSupportRequest } from "./create-support-request";
import {
  SUPPORT_REQUEST_FIELD_ERRORS,
  SUPPORT_REQUEST_MESSAGE_MAX_LENGTH,
  SUPPORT_REQUEST_RATE_LIMITED_CODE,
  SUPPORT_REQUEST_SUBJECT_MAX_LENGTH,
} from "./support-request";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const INPUT = {
  category: "billing",
  subject: "Charged twice",
  message: "I see two charges for March.",
};

const STORED = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  created_at: "2026-03-01T10:00:00+00:00",
  category: "billing",
  status: "open",
  subject: INPUT.subject,
  message: INPUT.message,
};

const withRow = (row: unknown = STORED) =>
  createFakeSupabase(() => ({ ...OK_RESPONSE, status: 201, data: row }));

const withError = (error: { message: string; code?: string }) =>
  createFakeSupabase(() => ({ ...OK_RESPONSE, status: 400, data: null, error }));

/** `{ method: args }` view of one query, for readable assertions. */
const shape = (query: FakeQuery) =>
  query.calls.map((call) => [call.method, ...call.args]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSupportRequest – the write", () => {
  it("inserts as the user, naming only the columns a user may supply", async () => {
    const fake = withRow();
    infra.createClient.mockResolvedValue(fake.client);

    await createSupportRequest(USER, INPUT);

    expect(infra.createClient).toHaveBeenCalledTimes(1);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].table).toBe("support_requests");
    expect(shape(fake.queries[0])).toEqual([
      ["insert", INPUT],
      ["select", "id, created_at, category, status, subject, message"],
      ["single"],
    ]);
  });

  it("never lets the caller choose the owner, status, time or id", async () => {
    const fake = withRow();

    await createSupportRequest(
      USER,
      {
        ...INPUT,
        user_id: OTHER,
        status: "closed",
        created_at: "2020-01-01T00:00:00Z",
        id: "99999999-9999-4999-8999-999999999999",
      },
      { supabase: fake.client },
    );

    // The insert carries the three fields and nothing else: the database fills
    // user_id from auth.uid() and the rest from its defaults.
    const [inserted] = fake.argsOf(fake.queries[0], "insert") as [
      Record<string, unknown>,
    ];
    expect(inserted).toEqual(INPUT);
    expect(JSON.stringify(inserted)).not.toContain(OTHER);
  });

  it("stores the trimmed text", async () => {
    const fake = withRow();

    await createSupportRequest(
      USER,
      {
        ...INPUT,
        subject: "  Charged twice  ",
        message: "\n I see two charges for March. \n",
      },
      { supabase: fake.client },
    );

    expect(fake.argsOf(fake.queries[0], "insert")).toEqual([INPUT]);
  });

  it("returns the stored request", async () => {
    const fake = withRow();

    await expect(
      createSupportRequest(USER, INPUT, { supabase: fake.client }),
    ).resolves.toEqual({
      ok: true,
      request: {
        id: STORED.id,
        createdAt: STORED.created_at,
        category: "billing",
        status: "open",
        subject: INPUT.subject,
        message: INPUT.message,
      },
    });
  });
});

describe("createSupportRequest – validation", () => {
  it.each([
    [
      "a missing category",
      { category: undefined },
      "category",
      SUPPORT_REQUEST_FIELD_ERRORS.categoryInvalid,
    ],
    [
      "an unknown category",
      { category: "sales" },
      "category",
      SUPPORT_REQUEST_FIELD_ERRORS.categoryInvalid,
    ],
    [
      "a blank subject",
      { subject: "   " },
      "subject",
      SUPPORT_REQUEST_FIELD_ERRORS.subjectRequired,
    ],
    [
      "a long subject",
      { subject: "x".repeat(SUPPORT_REQUEST_SUBJECT_MAX_LENGTH + 1) },
      "subject",
      SUPPORT_REQUEST_FIELD_ERRORS.subjectTooLong,
    ],
    [
      "a multi-line subject",
      { subject: "a\nb" },
      "subject",
      SUPPORT_REQUEST_FIELD_ERRORS.subjectInvalid,
    ],
    [
      "a blank message",
      { message: " \n " },
      "message",
      SUPPORT_REQUEST_FIELD_ERRORS.messageRequired,
    ],
    [
      "a long message",
      { message: "m".repeat(SUPPORT_REQUEST_MESSAGE_MAX_LENGTH + 1) },
      "message",
      SUPPORT_REQUEST_FIELD_ERRORS.messageTooLong,
    ],
    [
      "a message with NUL",
      { message: "a\u0000b" },
      "message",
      SUPPORT_REQUEST_FIELD_ERRORS.messageInvalid,
    ],
  ])(
    "refuses %s before contacting the database",
    async (_label, override, field, error) => {
      const fake = withRow();

      await expect(
        createSupportRequest(USER, { ...INPUT, ...override }, { supabase: fake.client }),
      ).resolves.toEqual({ ok: false, failure: "invalid", field, error });

      expect(fake.queries).toHaveLength(0);
    },
  );

  it.each([
    ["null", null],
    ["a string", "help me"],
    ["an empty object", {}],
  ])("refuses %s as input", async (_label, input) => {
    const fake = withRow();

    const result = await createSupportRequest(USER, input, { supabase: fake.client });

    expect(result).toMatchObject({ ok: false, failure: "invalid" });
    expect(fake.queries).toHaveLength(0);
  });

  it("reports the first failing field only", async () => {
    const fake = withRow();

    const result = await createSupportRequest(
      USER,
      { category: "sales", subject: "", message: "" },
      { supabase: fake.client },
    );

    expect(result).toMatchObject({ field: "category" });
  });
});

describe("createSupportRequest – failures", () => {
  it("reports the flood limit from the database", async () => {
    const fake = withError({
      message: "Too many support requests; try again later",
      code: SUPPORT_REQUEST_RATE_LIMITED_CODE,
    });

    await expect(
      createSupportRequest(USER, INPUT, { supabase: fake.client }),
    ).resolves.toEqual({
      ok: false,
      failure: "rateLimited",
    });
    // An expected outcome, not an incident: no error log.
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([["42501"], ["23503"], ["PGRST301"]])(
    "reports a lost session for SQLSTATE %s",
    async (code) => {
      const fake = withError({ message: "denied", code });

      await expect(
        createSupportRequest(USER, INPUT, { supabase: fake.client }),
      ).resolves.toEqual({
        ok: false,
        failure: "sessionExpired",
      });
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("reports a constraint violation as invalid and logs it (the schema and the database disagree)", async () => {
    const fake = withError({ message: "violates check constraint", code: "23514" });

    await expect(
      createSupportRequest(USER, INPUT, { supabase: fake.client }),
    ).resolves.toEqual({
      ok: false,
      failure: "invalid",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[support] could not file a request",
      expect.objectContaining({ userId: USER, error: { code: "23514" } }),
    );
  });

  it("reports anything else as unavailable, logging the SQLSTATE only", async () => {
    const fake = withError({
      message: 'insert into "support_requests" failed: my password is hunter2',
      code: "42P01",
    });

    await expect(
      createSupportRequest(USER, INPUT, { supabase: fake.client }),
    ).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });

    const [, logged] = vi.mocked(console.error).mock.calls[0];
    expect(JSON.stringify(logged)).not.toContain("hunter2");
    expect(JSON.stringify(logged)).not.toContain(INPUT.message);
  });

  it("never throws when the client or the network does", async () => {
    infra.createClient.mockRejectedValue(new TypeError("fetch failed"));

    await expect(createSupportRequest(USER, INPUT)).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[support] filing a request threw unexpectedly",
      expect.objectContaining({ error: { name: "TypeError" } }),
    );
  });

  it("logs only the type of a non-Error throw, never its value", async () => {
    infra.createClient.mockRejectedValue("secret detail");

    await createSupportRequest(USER, INPUT);

    expect(console.error).toHaveBeenCalledWith(
      "[support] filing a request threw unexpectedly",
      { userId: USER, error: { name: "string" } },
    );
  });

  it("does not log what the user wrote when the request throws", async () => {
    infra.createClient.mockRejectedValue(new Error("boom"));

    await createSupportRequest(USER, { ...INPUT, message: "card 4242424242424242" });

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("4242424242424242");
  });

  it("reports success when the request was filed but the echo cannot be read", async () => {
    // The row was written (no error); only the representation is unusable.
    // Reporting a failure would make the user send it again.
    const fake = withRow({ id: "not-a-uuid" });

    await expect(
      createSupportRequest(USER, INPUT, { supabase: fake.client }),
    ).resolves.toEqual({
      ok: true,
      request: null,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[support] request was filed but could not be read back",
      { userId: USER },
    );
  });

  it("keeps a request whose category or status this version does not know", async () => {
    const fake = withRow({ ...STORED, category: "shipping", status: "escalated" });

    await expect(
      createSupportRequest(USER, INPUT, { supabase: fake.client }),
    ).resolves.toMatchObject({
      ok: true,
      request: { category: null, status: null, subject: INPUT.subject },
    });
  });
});
