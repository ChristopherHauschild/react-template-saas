// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, OK_RESPONSE } from "@/shared/test/supabase";

// The service-role client; constructing the real one needs env and is covered
// by admin.test.ts.
const admin = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/infrastructure/supabase/admin", () => admin);

// Must never be touched: the writer acts as the service role, not as the user.
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => {
    throw new Error("the activity writer must not read request cookies");
  }),
}));

import type { AccountActivityEvent } from "./events";
import { recordAccountActivity } from "./record-account-activity";

const USER = "11111111-1111-4111-8111-111111111111";
const EVENT: AccountActivityEvent = {
  type: "profile.updated",
  details: { changes: { fullName: { from: "Jane", to: "Jane Doe" } } },
};

const loggedText = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordAccountActivity", () => {
  it("calls the record function as the service role with the user id, type and details", async () => {
    const fake = createFakeSupabase(() => ({ ...OK_RESPONSE, status: 200, data: 42 }));
    admin.createAdminClient.mockReturnValue(fake.client);

    await expect(recordAccountActivity(USER, EVENT)).resolves.toEqual({
      ok: true,
      id: 42,
    });

    expect(admin.createAdminClient).toHaveBeenCalledTimes(1);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].table).toBe("record_account_activity");
    expect(fake.argsOf(fake.queries[0], "rpc")).toEqual([
      "record_account_activity",
      {
        p_user_id: USER,
        p_event_type: "profile.updated",
        p_details: { changes: { fullName: { from: "Jane", to: "Jane Doe" } } },
      },
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("uses an injected client instead of building the service-role one", async () => {
    const fake = createFakeSupabase(() => ({ ...OK_RESPONSE, status: 200, data: 1 }));

    await expect(recordAccountActivity(USER, EVENT, fake.client)).resolves.toEqual({
      ok: true,
      id: 1,
    });
    expect(admin.createAdminClient).not.toHaveBeenCalled();
  });

  it("accepts the id as a string (bigint serialisations) but not garbage", async () => {
    const fake = createFakeSupabase(() => ({ ...OK_RESPONSE, status: 200, data: "7" }));
    await expect(recordAccountActivity(USER, EVENT, fake.client)).resolves.toEqual({
      ok: true,
      id: 7,
    });

    const odd = createFakeSupabase(() => ({ ...OK_RESPONSE, status: 200, data: null }));
    await expect(recordAccountActivity(USER, EVENT, odd.client)).resolves.toEqual({
      ok: false,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[account-activity] unexpected response from record function",
      expect.objectContaining({ type: "profile.updated" }),
    );
  });

  describe("failures are reported, never thrown", () => {
    it("returns ok: false and logs code + message (not details/hint) when the database refuses", async () => {
      const fake = createFakeSupabase(() => ({
        ...OK_RESPONSE,
        status: 403,
        data: null,
        error: {
          message: "permission denied for function record_account_activity",
          code: "42501",
          details: "Failing row contains (1, Jane Doe, SECRET)",
          hint: "SECRET hint",
        },
      }));

      await expect(recordAccountActivity(USER, EVENT, fake.client)).resolves.toEqual({
        ok: false,
      });

      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(
        "[account-activity] could not record event",
        {
          type: "profile.updated",
          userId: USER,
          error: {
            message: "permission denied for function record_account_activity",
            code: "42501",
          },
        },
      );
      expect(loggedText()).not.toContain("SECRET");
      expect(loggedText()).not.toContain("Jane");
    });

    it("turns a thrown error (client construction) into ok: false, logging only its class", async () => {
      admin.createAdminClient.mockImplementation(() => {
        throw new TypeError(`SUPABASE_SERVICE_ROLE_KEY missing for ${USER} Jane`);
      });

      await expect(recordAccountActivity(USER, EVENT)).resolves.toEqual({ ok: false });

      expect(console.error).toHaveBeenCalledWith(
        "[account-activity] recording threw unexpectedly",
        { type: "profile.updated", userId: USER, error: { name: "TypeError" } },
      );
      expect(loggedText()).not.toContain("Jane");
      expect(loggedText()).not.toContain("missing");
    });

    it("turns a rejected query into ok: false as well", async () => {
      const fake = createFakeSupabase(() => {
        throw new Error("socket hang up");
      });

      await expect(recordAccountActivity(USER, EVENT, fake.client)).resolves.toEqual({
        ok: false,
      });
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it("refuses an event that does not match the catalogue, without contacting the database", async () => {
      const fake = createFakeSupabase();
      const bogus = {
        type: "profile.updated",
        details: { changes: { fullName: { from: "Jane", to: undefined } } },
      } as unknown as AccountActivityEvent;

      await expect(recordAccountActivity(USER, bogus, fake.client)).resolves.toEqual({
        ok: false,
      });

      expect(fake.queries).toHaveLength(0);
      expect(console.error).toHaveBeenCalledWith(
        "[account-activity] event does not match its schema; not recorded",
        { type: "profile.updated", issues: ["details.changes.fullName.to"] },
      );
      expect(loggedText()).not.toContain("Jane");
    });

    it("refuses an unknown event type", async () => {
      const fake = createFakeSupabase();

      await expect(
        recordAccountActivity(
          USER,
          { type: "profile.deleted", details: {} } as unknown as AccountActivityEvent,
          fake.client,
        ),
      ).resolves.toEqual({ ok: false });
      expect(fake.queries).toHaveLength(0);
    });
  });
});
