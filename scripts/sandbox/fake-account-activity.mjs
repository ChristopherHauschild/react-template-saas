/**
 * SANDBOX ONLY — account activity and rate limits for the Supabase stand-in
 * (`fake-supabase.mjs`), so the settings card and the exports page can be
 * exercised end to end, unmocked:
 *
 *   GET  /rest/v1/account_activity?…        the PostgREST query the app sends
 *   POST /rest/v1/rpc/consume_rate_limit    the export allowance (service role)
 *
 * The read is emulated STRICTLY for the one query shape the application uses
 * (`readAccountActivityPage`): `select`, `user_id=eq.`, `occurred_at=gte./lt.`,
 * the keyset `or=(…)`, `order=occurred_at.desc,id.desc`, `limit`. Anything
 * else is refused with a 400, as PostgREST refuses what it cannot parse — so
 * if the application's query ever changes, the sandbox fails loudly instead of
 * answering something plausible. `src/infrastructure/account-activity/
 * sandbox-fake-supabase.test.ts` runs the real reader against this file.
 *
 * Seeded histories (deterministic, relative to when the sandbox starts):
 *   demo@example.com   ~40 entries of every kind, incl. two this app cannot
 *                      describe and display names that look like formulas
 *   huge@example.com   2,400 entries over ~2 years, many sharing a timestamp
 *   empty@example.com  no activity
 *   broken@example.com every read fails (500)
 *   everyone else      a handful of entries
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
const OLDER_THAN =
  /^\(occurred_at\.lt\."([^"]+)",and\(occurred_at\.eq\."([^"]+)",id\.lt\.(\d+)\)\)$/;
const COLUMNS = ["id", "user_id", "event_type", "details", "occurred_at"];

/** Microseconds since the epoch for an ISO timestamp with any offset; `null` if unparsable. */
function micros(timestamp) {
  const match = TIMESTAMP.exec(timestamp);
  if (!match) return null;
  const seconds = Date.parse(match[1] + match[3]);
  if (Number.isNaN(seconds)) return null;
  return seconds * 1000 + Number((match[2] ?? "").padEnd(6, "0"));
}

/** PostgREST's rendering of a timestamptz: `2026-03-01T10:00:00.123456+00:00`. */
function render(us) {
  const ms = Math.floor(us / 1000);
  const iso = new Date(ms).toISOString(); // …T10:00:00.123Z
  return `${iso.slice(0, 19)}.${String(us % 1_000_000).padStart(6, "0")}+00:00`;
}

// ---- seed ----------------------------------------------------------------------

const NAMES = [
  "Ada Lovelace",
  'Ada "The Countess", Lovelace',
  '=HYPERLINK("https://example.com","click")',
  "Zoë Ångström",
  "李雷",
  "Ada L.",
];

/** One recognised event of kind `k` (0..5); `i` varies the details. */
function event(k, i) {
  switch (k % 6) {
    case 0: {
      // Profile changes are every sixth event: walk the names one change at a time.
      const n = Math.floor(i / 6);
      return {
        event_type: "profile.updated",
        details: {
          changes: {
            fullName: {
              from: n === 0 ? null : NAMES[(n - 1) % NAMES.length],
              to: NAMES[n % NAMES.length],
            },
          },
        },
      };
    }
    case 1:
      return {
        event_type: "password.changed",
        details: { otherSessionsSignedOut: i % 2 === 0 },
      };
    case 2:
      return { event_type: "sessions.others_signed_out", details: {} };
    case 3:
      return {
        event_type: "email.change_requested",
        details: {
          from: `user${i}@example.com`,
          to: `user${i + 1}@example.com`,
          resend: i % 4 === 3,
        },
      };
    case 4:
      return { event_type: "email.changed", details: { to: `user${i + 1}@example.com` } };
    default:
      return {
        event_type: "profile.updated",
        details: { changes: { fullName: { from: "A", to: "B" } } },
      };
  }
}

/**
 * Rows of `public.account_activity` for the sandbox's users (`emailToId`:
 * email → user id). Ids ascend with time, as the identity column would.
 */
export function seedAccountActivity(emailToId, now = Date.now()) {
  const rows = [];
  let id = 0;
  const day = 86_400_000 * 1000; // in µs
  const nowUs = now * 1000;

  const add = (userId, atUs, { event_type, details }) =>
    rows.push({ id: ++id, user_id: userId, event_type, details, occurred_at: atUs });

  for (const [email, userId] of emailToId) {
    if (email === "empty@example.com") continue;

    if (email === "huge@example.com") {
      // 2,400 entries over ~2 years, oldest first; every 7th group of three
      // shares one timestamp (recorded in one transaction), to the microsecond.
      const start = nowUs - 730 * day;
      for (let i = 0; i < 2400; ) {
        const at = start + Math.floor((i / 2400) * 730 * day) + 123_456;
        const group = i % 7 === 0 ? 3 : 1;
        for (let g = 0; g < group && i < 2400; g++, i++) add(userId, at, event(i, i));
      }
      continue;
    }

    const demo = email === "demo@example.com";
    const count = demo ? 40 : 5;
    const spanDays = demo ? 120 : 30; // all in the past, oldest first
    const start = nowUs - spanDays * day;
    for (let i = 0; i < count; i++) {
      add(
        userId,
        start + Math.floor((i / count) * spanDays * day) + 654_321,
        event(i, i),
      );
    }

    if (email === "demo@example.com") {
      // Two entries this version of the app cannot describe: listed, never dropped.
      add(userId, nowUs - 10 * day + 1, {
        event_type: "billing.plan_changed",
        details: { from: "pro", to: "enterprise" },
      });
      add(userId, nowUs - 5 * day + 2, {
        event_type: "profile.updated",
        details: { changes: { avatar: "old shape" } },
      });
    }
  }

  return rows;
}

// ---- the read ------------------------------------------------------------------

const bad = (message) => ({
  status: 400,
  body: { code: "PGRST100", message: `sandbox: ${message}`, details: null, hint: null },
});

/**
 * Answers `GET /rest/v1/account_activity` for `user` (from the bearer token;
 * `null` when there is none). `failingUserIds`: users whose reads fail.
 */
export function readAccountActivity(rows, url, user, failingUserIds = new Set()) {
  if (!user)
    return { status: 401, body: { code: "PGRST301", message: "JWT missing or invalid" } };
  if (failingUserIds.has(user.id)) {
    return {
      status: 500,
      body: { code: "XX000", message: "sandbox: activity reads fail for this account" },
    };
  }

  const params = url.searchParams;
  const known = new Set(["select", "user_id", "occurred_at", "or", "order", "limit"]);
  for (const name of params.keys()) {
    if (!known.has(name)) return bad(`unsupported parameter "${name}"`);
  }

  const columns = (params.get("select") ?? "").split(",").map((c) => c.trim());
  if (columns.length === 0 || columns.some((c) => !COLUMNS.includes(c))) {
    return bad(`unsupported select "${params.get("select")}"`);
  }

  const owner = params.getAll("user_id");
  if (
    owner.length !== 1 ||
    !owner[0].startsWith("eq.") ||
    !UUID.test(owner[0].slice(3))
  ) {
    return bad("user_id must be exactly one eq.<uuid> filter");
  }

  // Row level security: the caller's own rows, whatever the filter says.
  let result = rows.filter(
    (row) => row.user_id === user.id && row.user_id === owner[0].slice(3),
  );

  for (const filter of params.getAll("occurred_at")) {
    const match = /^(gte|lt)\.(.+)$/.exec(filter);
    const bound = match ? micros(match[2]) : null;
    if (!match || bound === null)
      return bad(`unsupported occurred_at filter "${filter}"`);
    result = result.filter((row) =>
      match[1] === "gte" ? row.occurred_at >= bound : row.occurred_at < bound,
    );
  }

  const or = params.getAll("or");
  if (or.length > 1) return bad("at most one or filter");
  if (or.length === 1) {
    const match = OLDER_THAN.exec(or[0]);
    const t = match ? micros(match[1]) : null;
    if (!match || match[1] !== match[2] || t === null)
      return bad(`unsupported or filter "${or[0]}"`);
    const before = Number(match[3]);
    result = result.filter(
      (row) => row.occurred_at < t || (row.occurred_at === t && row.id < before),
    );
  }

  if (params.get("order") !== "occurred_at.desc,id.desc") {
    return bad(`unsupported order "${params.get("order")}"`);
  }
  result = [...result].sort((a, b) => b.occurred_at - a.occurred_at || b.id - a.id);

  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 10_000) {
      return bad(`unsupported limit "${limit}"`);
    }
    result = result.slice(0, Number(limit));
  }

  return {
    status: 200,
    body: result.map((row) =>
      Object.fromEntries(
        columns.map((c) => [c, c === "occurred_at" ? render(row.occurred_at) : row[c]]),
      ),
    ),
  };
}

// ---- the rate limiter ----------------------------------------------------------

/**
 * `public.consume_rate_limit`, in memory: the migration's GCRA, validation and
 * answer shape. Service role only. `reset()` forgets every allowance (the
 * sandbox's `/__sandbox/rate-limits/reset`). `users`: anything with
 * `has(id)` — the stand-in's live user map, so later sign-ups count too.
 */
export function createRateLimits(users) {
  const tat = new Map();

  return {
    reset: () => tat.clear(),
    consume({ p_user_id, p_bucket, p_interval_seconds, p_burst }) {
      if (!p_user_id || !p_bucket) {
        return {
          status: 400,
          body: { code: "22004", message: "user and bucket are required" },
        };
      }
      if (
        !Number.isInteger(p_interval_seconds) ||
        p_interval_seconds < 1 ||
        p_interval_seconds > 86400
      ) {
        return {
          status: 400,
          body: { code: "22023", message: "interval must be 1..86400 seconds" },
        };
      }
      if (!Number.isInteger(p_burst) || p_burst < 1 || p_burst > 1000) {
        return { status: 400, body: { code: "22023", message: "burst must be 1..1000" } };
      }
      if (
        !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(p_bucket) ||
        p_bucket.length > 64
      ) {
        return {
          status: 400,
          body: { code: "23514", message: "rate_limits_bucket_format" },
        };
      }
      if (!users.has(p_user_id)) {
        return {
          status: 409,
          body: { code: "23503", message: "rate_limits_user_id_fkey" },
        };
      }

      const key = `${p_user_id}|${p_bucket}`;
      const now = Date.now();
      const interval = p_interval_seconds * 1000;
      const tolerance = interval * (p_burst - 1);
      const current = Math.max(tat.get(key) ?? -Infinity, now);

      if (current - now > tolerance) {
        const retry = Math.max(1, Math.ceil((current - tolerance - now) / 1000));
        return { status: 200, body: [{ allowed: false, retry_after_seconds: retry }] };
      }

      tat.set(key, current + interval);
      return { status: 200, body: [{ allowed: true, retry_after_seconds: 0 }] };
    },
  };
}
