import { describe, expect, it } from "vitest";

import type { AccountActivityEntry } from "@/infrastructure/account-activity/list-account-activity";

import {
  groupAccountActivityByDay,
  UNKNOWN_DAY_KEY,
  UNKNOWN_DAY_LABEL,
} from "./account-activity-timeline";

const at = (id: number, occurredAt: string): AccountActivityEntry => ({
  id,
  occurredAt,
  event: { type: "sessions.others_signed_out", details: {} },
});

describe("groupAccountActivityByDay", () => {
  it("returns nothing for nothing", () => {
    expect(groupAccountActivityByDay([])).toEqual([]);
  });

  it("groups consecutive entries of the same UTC day, in the order given", () => {
    const entries = [
      at(4, "2026-03-02T23:59:59+00:00"),
      at(3, "2026-03-02T00:00:00+00:00"),
      at(2, "2026-03-01T12:00:00+00:00"),
      at(1, "2026-02-27T12:00:00+00:00"),
    ];

    expect(groupAccountActivityByDay(entries)).toEqual([
      { key: "2026-03-02", label: "2 Mar 2026", entries: [entries[0], entries[1]] },
      { key: "2026-03-01", label: "1 Mar 2026", entries: [entries[2]] },
      { key: "2026-02-27", label: "27 Feb 2026", entries: [entries[3]] },
    ]);
  });

  it("uses the UTC day, whatever offset the timestamp carries", () => {
    // 23:30 at UTC-2 is 01:30 UTC on the 2nd; 01:30 at UTC+3 is 22:30 UTC on the 28th.
    const [late, early] = groupAccountActivityByDay([
      at(2, "2026-03-01T23:30:00-02:00"),
      at(1, "2026-03-01T01:30:00+03:00"),
    ]);

    expect(late.key).toBe("2026-03-02");
    expect(early.key).toBe("2026-02-28");
  });

  it("never re-sorts: the same day appearing again later starts a new group", () => {
    // Not expected from the server (newest first), but the order shown must be the order given.
    const groups = groupAccountActivityByDay([
      at(3, "2026-03-02T10:00:00+00:00"),
      at(2, "2026-03-01T10:00:00+00:00"),
      at(1, "2026-03-02T09:00:00+00:00"),
    ]);

    expect(groups.map((g) => g.key)).toEqual(["2026-03-02", "2026-03-01", "2026-03-02"]);
  });

  it("puts entries whose time cannot be read under an 'unknown' day, keeping them", () => {
    const groups = groupAccountActivityByDay([
      at(2, "2026-03-01T10:00:00+00:00"),
      at(1, "garbage"),
    ]);

    expect(groups[1]).toEqual({
      key: UNKNOWN_DAY_KEY,
      label: UNKNOWN_DAY_LABEL,
      entries: [expect.objectContaining({ id: 1 })],
    });
  });

  it("does not mutate the entries it is given", () => {
    const entries = [
      at(2, "2026-03-01T10:00:00+00:00"),
      at(1, "2026-03-01T09:00:00+00:00"),
    ];
    const copy = structuredClone(entries);

    groupAccountActivityByDay(entries);

    expect(entries).toEqual(copy);
  });
});
