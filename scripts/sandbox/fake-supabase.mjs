/**
 * SANDBOX ONLY — a stand-in for the two Supabase endpoints this application
 * uses, so it can run without Docker, the Supabase CLI or network access:
 *
 *   Auth (GoTrue):  POST /auth/v1/token?grant_type=password|refresh_token
 *                   POST /auth/v1/signup          (auto-confirmed)
 *                   GET  /auth/v1/user
 *                   POST /auth/v1/logout
 *   REST (PostgREST): GET /rest/v1/subscriptions?select=…&userId=eq.<uuid>
 *                     GET /rest/v1/account_activity?…  (see fake-account-activity.mjs)
 *                     POST /rest/v1/rpc/consume_rate_limit  (service role only)
 *                     GET/POST /rest/v1/support_requests  (support demo)
 *   Sandbox control:  GET /__sandbox/rate-limits/reset  (forget every export allowance)
 *
 * Row-level security is emulated: a request only ever sees the rows of the
 * user its bearer token names. Tokens are real HS256 JWTs signed with a
 * throwaway secret. Everything is in memory and reset on restart.
 *
 * Accounts (password for all: `password123`) — see `ACCOUNTS` below.
 */
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  createRateLimits,
  readAccountActivity,
  seedAccountActivity,
} from "./fake-account-activity.mjs";

export const PASSWORD = "password123";

/** email → Stripe customers the user's subscription rows point at (customer, status). */
export const ACCOUNTS = {
  "demo@example.com": [["cus_sandboxDemo", "active"]],
  "canceled@example.com": [["cus_sandboxDemo", "canceled"]],
  "other@example.com": [["cus_sandboxOther", "active"]],
  "empty@example.com": [["cus_sandboxEmpty", "active"]],
  "drafts@example.com": [["cus_sandboxOnlyDrafts", "active"]],
  "broken@example.com": [["cus_sandboxBroken", "active"]],
  "unknown@example.com": [["cus_sandboxUnknown", "active"]],
  "huge@example.com": [["cus_sandboxHuge", "active"]],
  "ambiguous@example.com": [
    ["cus_sandboxDemo", "active"],
    ["cus_sandboxOther", "active"],
  ],
  "free@example.com": [],
};

const JWT_SECRET = "sandbox-only-not-a-secret";
const TOKEN_TTL_SECONDS = 3600;

export function startFakeSupabase(port = 54321) {
  /** id → user */
  const users = new Map();
  /** email → { id, password } */
  const byEmail = new Map();
  /** refresh token → user id */
  const refreshTokens = new Map();
  /** rows of public.subscriptions */
  const subscriptions = [];
  /** rows of public.support_requests, sandbox only. */
  const supportRequests = [];

  const addUser = (email, password) => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const user = {
      id,
      aud: "authenticated",
      role: "authenticated",
      email,
      email_confirmed_at: now,
      confirmed_at: now,
      last_sign_in_at: now,
      phone: "",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      identities: [],
      created_at: now,
      updated_at: now,
      is_anonymous: false,
    };
    users.set(id, user);
    byEmail.set(email, { id, password });
    return user;
  };

  for (const [email, links] of Object.entries(ACCOUNTS)) {
    const user = addUser(email, PASSWORD);
    links.forEach(([customer, status], i) => {
      subscriptions.push({
        id: randomUUID(),
        stripe_customer_id: customer,
        stripe_subscription_id: `sub_sandbox${email.split("@")[0]}${i}`,
        status,
        userId: user.id,
      });
    });
  }

  {
    // Older than the flood-limit window, one minute apart.
    const demo = byEmail.get("demo@example.com");
    const start = Date.now() - 2 * 24 * 3600 * 1000;
    for (let n = 1; n <= SEEDED_SUPPORT_REQUESTS; n++) {
      supportRequests.push({
        id: randomUUID(),
        user_id: demo.id,
        category: ["account", "billing", "technical", "other"][n % 4],
        subject: `Sandbox request ${n}`,
        message: `An older request (${n}) so the history has something to page through.`,
        status: n % 3 === 0 ? "closed" : "open",
        created_at: new Date(start + n * 60_000).toISOString(),
      });
    }
  }

  // Account activity (seeded per account) and the export allowances.
  const emailToId = new Map([...byEmail].map(([email, { id }]) => [email, id]));
  const activity = seedAccountActivity(emailToId);
  const failingActivity = new Set(
    [byEmail.get("broken@example.com")?.id].filter(Boolean),
  );
  // The live map: users who sign up in the sandbox have allowances too.
  const rateLimits = createRateLimits(users);
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "sandbox-service-role-key";
  const isServiceRole = (req) => req.headers.authorization === `Bearer ${serviceRoleKey}`;

  const session = (user) => {
    const now = Math.floor(Date.now() / 1000);
    const refresh = randomUUID();
    refreshTokens.set(refresh, user.id);
    return {
      access_token: signJwt({
        iss: `http://127.0.0.1:${port}/auth/v1`,
        sub: user.id,
        aud: "authenticated",
        exp: now + TOKEN_TTL_SECONDS,
        iat: now,
        email: user.email,
        phone: "",
        app_metadata: user.app_metadata,
        user_metadata: {},
        role: "authenticated",
        aal: "aal1",
        amr: [{ method: "password", timestamp: now }],
        session_id: randomUUID(),
        is_anonymous: false,
      }),
      token_type: "bearer",
      expires_in: TOKEN_TTL_SECONDS,
      expires_at: now + TOKEN_TTL_SECONDS,
      refresh_token: refresh,
      user,
    };
  };

  const userFromBearer = (req) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const claims = token ? verifyJwt(token) : null;
    return claims ? (users.get(claims.sub) ?? null) : null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }

    const json = (status, body, extra = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    const authError = (status, code, msg) =>
      json(status, { code: status, error_code: code, msg });

    try {
      // ---- Auth -----------------------------------------------------------
      if (url.pathname === "/auth/v1/token" && req.method === "POST") {
        const body = await readJson(req);
        const grant = url.searchParams.get("grant_type");

        if (grant === "password") {
          const account = byEmail.get(String(body.email ?? "").toLowerCase());
          if (!account || account.password !== body.password) {
            return authError(400, "invalid_credentials", "Invalid login credentials");
          }
          return json(200, session(users.get(account.id)));
        }

        if (grant === "refresh_token") {
          const userId = refreshTokens.get(String(body.refresh_token ?? ""));
          if (!userId)
            return authError(400, "refresh_token_not_found", "Invalid Refresh Token");
          refreshTokens.delete(body.refresh_token);
          return json(200, session(users.get(userId)));
        }

        return authError(400, "unsupported_grant_type", "unsupported grant type");
      }

      if (url.pathname === "/auth/v1/signup" && req.method === "POST") {
        const body = await readJson(req);
        const email = String(body.email ?? "").toLowerCase();
        if (!email.includes("@") || String(body.password ?? "").length < 6) {
          return authError(
            422,
            "validation_failed",
            "Signup requires a valid email and password",
          );
        }
        if (byEmail.has(email)) {
          return authError(422, "user_already_exists", "User already registered");
        }
        // Confirmations are off in the sandbox: sign-up signs the user in.
        return json(200, session(addUser(email, String(body.password))));
      }

      if (url.pathname === "/auth/v1/user" && req.method === "GET") {
        const user = userFromBearer(req);
        return user ? json(200, user) : authError(401, "bad_jwt", "invalid JWT");
      }

      if (url.pathname === "/auth/v1/logout" && req.method === "POST") {
        res.writeHead(204, cors).end();
        return;
      }

      // ---- REST -------------------------------------------------------------
      if (url.pathname === "/rest/v1/subscriptions" && req.method === "GET") {
        const user = userFromBearer(req);
        if (!user) {
          return json(401, { message: "JWT missing or invalid", code: "PGRST301" });
        }

        const columns = (url.searchParams.get("select") ?? "*")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        const filter = url.searchParams.get("userId");
        const wanted = filter?.startsWith("eq.") ? filter.slice(3) : null;

        // RLS: only the caller's own rows, whatever the filter says.
        const rows = subscriptions
          .filter(
            (row) => row.userId === user.id && (wanted === null || row.userId === wanted),
          )
          .map((row) =>
            columns.includes("*")
              ? row
              : Object.fromEntries(columns.map((c) => [c, row[c] ?? null])),
          );

        return json(200, rows, { "Content-Range": `0-${rows.length}/*` });
      }

      if (url.pathname === "/rest/v1/account_activity" && req.method === "GET") {
        const { status, body } = readAccountActivity(
          activity,
          url,
          userFromBearer(req),
          failingActivity,
        );
        return json(status, body);
      }

      if (url.pathname === "/rest/v1/rpc/consume_rate_limit" && req.method === "POST") {
        // EXECUTE is granted to service_role alone.
        if (!isServiceRole(req)) {
          return json(401, {
            code: "42501",
            message: "permission denied for function consume_rate_limit",
          });
        }
        const { status, body } = rateLimits.consume(await readJson(req));
        return json(status, body);
      }

      if (url.pathname === "/__sandbox/rate-limits/reset" && req.method === "GET") {
        rateLimits.reset();
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...cors });
        res.end("Every export allowance has been reset.\n");
        return;
      }

      if (url.pathname === "/rest/v1/support_requests") {
        const user = userFromBearer(req);
        if (!user) {
          // Without a user PostgREST runs as `anon`, which may do nothing here.
          return json(401, {
            code: "42501",
            message: "permission denied for table support_requests",
          });
        }
        if (req.method === "GET")
          return listSupportRequests(url, user, supportRequests, json);
        if (req.method === "POST") {
          return createSupportRequest(req, user, supportRequests, json);
        }
      }

      if (url.pathname.startsWith("/rest/v1/")) {
        return json(404, { message: "relation does not exist (sandbox)", code: "42P01" });
      }

      json(404, {
        message: `sandbox Supabase: no route for ${req.method} ${url.pathname}`,
      });
    } catch (error) {
      json(500, { message: `sandbox Supabase: ${error.message}` });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// ---- helpers -----------------------------------------------------------------

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const b64url = (input) => Buffer.from(input).toString("base64url");

function signJwt(claims) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifyJwt(token) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  if (expected !== signature) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.SANDBOX_SUPABASE_PORT ?? 54321);
  await startFakeSupabase(port);
  console.log(`sandbox Supabase listening on http://127.0.0.1:${port}`);
}

// ---- support_requests (emulation; see the header) -------------------------------

const SEEDED_SUPPORT_REQUESTS = 12;
const SUPPORT_COLUMNS = [
  "id",
  "user_id",
  "category",
  "subject",
  "message",
  "status",
  "created_at",
];
const INSERTABLE = new Set(["category", "subject", "message"]);
const CATEGORIES = new Set(["account", "billing", "technical", "other"]);
/** The migration's "not blank": a character outside JavaScript's trim() whitespace. */
const notBlank = (value) => typeof value === "string" && value.trim() !== "";
const SUBJECT_FORBIDDEN = /[\u0001-\u001f\u007f-\u009f\u2028\u2029]/;
const chars = (value) => [...value].length;

function projectRow(row, select) {
  const columns =
    select === "*" ? SUPPORT_COLUMNS : select.split(",").map((c) => c.trim());
  return Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));
}

/** GET: the caller's rows only (RLS), with the filters, keyset cursor, order and limit the app sends. */
function listSupportRequests(url, user, rows, json) {
  const params = url.searchParams;
  const owner = params.get("user_id")?.replace(/^eq\./, "");
  let result = rows.filter(
    (r) => r.user_id === user.id && (!owner || r.user_id === owner),
  );

  const cursor = params
    .get("or")
    ?.match(
      /^\(created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]{36})\)\)$/,
    );
  if (params.has("or") && !cursor) {
    return json(400, { code: "PGRST100", message: "sandbox: unsupported filter" });
  }
  if (cursor) {
    const t = Date.parse(cursor[1]);
    result = result.filter((r) => {
      const at = Date.parse(r.created_at);
      return at < t || (at === t && r.id < cursor[3]);
    });
  }

  result.sort((a, b) =>
    a.created_at === b.created_at
      ? b.id.localeCompare(a.id)
      : Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  if (Number.isFinite(limit)) result = result.slice(0, limit);

  return json(
    200,
    result.map((r) => projectRow(r, params.get("select") ?? "*")),
  );
}

/** POST: one request for the caller, with the table's privileges, defaults, checks and flood limit. */
async function createSupportRequest(req, user, rows, json) {
  const body = await readJson(req);
  const url = new URL(req.url, "http://sandbox");

  if (Object.keys(body).some((key) => !INSERTABLE.has(key))) {
    return json(403, {
      code: "42501",
      message: "permission denied for table support_requests",
    });
  }
  const row = { category: "other", ...body };
  const valid =
    CATEGORIES.has(row.category) &&
    notBlank(row.subject) &&
    chars(row.subject) <= 150 &&
    !SUBJECT_FORBIDDEN.test(row.subject) &&
    notBlank(row.message) &&
    chars(row.message) <= 5000;
  if (!valid) {
    return json(400, {
      code: "23514",
      message: 'new row for relation "support_requests" violates check constraint',
    });
  }

  const hourAgo = Date.now() - 3600 * 1000;
  if (
    rows.filter((r) => r.user_id === user.id && Date.parse(r.created_at) > hourAgo)
      .length >= 5
  ) {
    return json(429, {
      code: "PT429",
      message: "Too many support requests; try again later",
    });
  }

  const stored = {
    ...row,
    id: randomUUID(),
    user_id: user.id,
    status: "open",
    created_at: new Date().toISOString(),
  };
  rows.push(stored);

  const projected = projectRow(stored, url.searchParams.get("select") ?? "*");
  const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
  return json(201, single ? projected : [projected]);
}

