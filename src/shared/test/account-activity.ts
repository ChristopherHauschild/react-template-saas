/**
 * Test stand-in for `public.account_activity` behind PostgREST, shared by the
 * collector and download-route tests. See `activityTable`.
 */
import { type FakeQuery, type FakeQueryResponse, OK_RESPONSE } from "./supabase";

/** A stored row, as the table holds it (`occurred_at` as PostgREST serialises it). */
export type StoredRow = {
  id: number;
  user_id: string;
  event_type: string;
  details: unknown;
  occurred_at: unknown;
};

/** Microseconds since the epoch for a PostgREST timestamp (keeps all six fractional digits). */
export const micros = (timestamp: string): number => {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    timestamp,
  );
  if (!match) throw new Error(`fake table: unparsable timestamp ${timestamp}`);
  return Date.parse(match[1] + match[3]) * 1000 + Number((match[2] ?? "").padEnd(6, "0"));
};

const OLDER_THAN =
  /^occurred_at\.lt\."([^"]+)",and\(occurred_at\.eq\."([^"]+)",id\.lt\.(\d+)\)$/;

/**
 * `public.account_activity` behind PostgREST, for the one query shape the
 * reader sends: `eq(user_id)`, optional keyset `or(...)`, ordered by
 * `(occurred_at desc, id desc)`, `limit`. Rows of every user are stored; the
 * `user_id` filter is what keeps them apart (as RLS would as well).
 */
export function activityTable(rows: StoredRow[], { ignoreRange = false } = {}) {
  return (query: FakeQuery): FakeQueryResponse => {
    const arg = (method: string) => query.calls.find((c) => c.method === method)?.args;
    const [column, user] = arg("eq") ?? [];
    if (column !== "user_id") throw new Error("fake table: query without user filter");

    let result = rows.filter((row) => row.user_id === user);

    // The date range: `gte`/`lt` on occurred_at, compared to the microsecond.
    for (const [method, keep] of [
      ["gte", (t: number, bound: number) => t >= bound],
      ["lt", (t: number, bound: number) => t < bound],
    ] as const) {
      const bound = arg(method);
      if (bound === undefined || ignoreRange) continue;
      if (bound[0] !== "occurred_at")
        throw new Error(`fake table: ${method} ${bound[0]}`);
      const limit = micros(String(bound[1]));
      result = result.filter((row) => keep(micros(String(row.occurred_at)), limit));
    }

    const or = arg("or")?.[0];
    if (or !== undefined) {
      const match = OLDER_THAN.exec(String(or));
      if (!match || match[1] !== match[2])
        throw new Error(`fake table: bad filter ${or}`);
      const [t, id] = [micros(match[1]), Number(match[3])];
      result = result.filter((row) => {
        const rt = micros(String(row.occurred_at));
        return rt < t || (rt === t && row.id < id);
      });
    }

    result = [...result].sort(
      (a, b) =>
        micros(String(b.occurred_at)) - micros(String(a.occurred_at)) || b.id - a.id,
    );

    const limit = Number(arg("limit")?.[0]);
    return {
      ...OK_RESPONSE,
      status: 200,
      data: result.slice(0, limit).map(({ id, event_type, details, occurred_at }) => ({
        id,
        event_type,
        details,
        occurred_at,
      })),
    };
  };
}
