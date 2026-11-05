// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writer = vi.hoisted(() => ({
  recordAccountActivity: vi.fn<() => Promise<{ ok: true; id: number } | { ok: false }>>(),
}));
vi.mock("@/infrastructure/account-activity/record-account-activity", () => writer);

import { recordSettingsActivity } from "./record-settings-activity";

const USER = "11111111-1111-4111-8111-111111111111";
const EVENT = {
  type: "profile.updated" as const,
  details: { changes: { fullName: { from: "Jane", to: "Jane Doe" } } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordSettingsActivity", () => {
  it("hands the event to the writer for the given user", async () => {
    writer.recordAccountActivity.mockResolvedValue({ ok: true, id: 1 });

    await expect(recordSettingsActivity(USER, EVENT)).resolves.toBeUndefined();

    expect(writer.recordAccountActivity).toHaveBeenCalledTimes(1);
    expect(writer.recordAccountActivity).toHaveBeenCalledWith(USER, EVENT);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("stays quiet when the writer reports a failure (the writer has logged it)", async () => {
    writer.recordAccountActivity.mockResolvedValue({ ok: false });

    await expect(recordSettingsActivity(USER, EVENT)).resolves.toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("REGRESSION: a writer that throws is contained — logged by class name, without the event's details", async () => {
    writer.recordAccountActivity.mockRejectedValue(
      new TypeError(`cannot read properties of ${USER} Jane Doe`),
    );

    await expect(recordSettingsActivity(USER, EVENT)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "[settings] activity recording threw; the change itself stands",
      { type: "profile.updated", error: { name: "TypeError" } },
    );
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("Jane");
    expect(logged).not.toContain(USER);
  });

  it("contains a synchronous throw from the writer as well", async () => {
    writer.recordAccountActivity.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(recordSettingsActivity(USER, EVENT)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
