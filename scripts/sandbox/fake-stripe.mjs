/**
 * SANDBOX ONLY — a stand-in for the parts of the Stripe API the billing pages
 * use, plus the documents Stripe would host, so everything can be exercised in
 * a browser without network access or a Stripe account:
 *
 *   GET  /v1/invoices?customer=…&limit=…&starting_after=…
 *   GET  /v1/invoices/:id
 *   GET  /v1/customers/:id
 *   GET  /v1/subscriptions/:id            (the subscriptions the Supabase stand-in's
 *                                          rows point at; see `subscriptionOf`)
 *   POST /v1/billing_portal/sessions      (answers with an https URL that is
 *                                          unreachable offline — the portal itself
 *                                          is not part of the sandbox)
 *   POST /v1/checkout/sessions            (same: an unreachable https URL; no
 *                                          subscription is ever created)
 *   GET  /i/:id                           the "hosted invoice page"
 *   GET  /invoice/:id/pdf                 the invoice PDF (a real, tiny PDF)
 *   GET  /__sandbox                       status page
 *   GET  /__sandbox/fail?mode=none|list|retrieve|all   flip failures at runtime
 *
 * Customers and what they hold — see `seed()`:
 *   cus_sandboxDemo        25 issued invoices (mixed statuses/currencies, a few
 *                          without a PDF, one with an unusable URL) behind 12 drafts
 *   cus_sandboxOther       3 invoices (for "another customer's document")
 *   cus_sandboxEmpty       no invoices
 *   cus_sandboxOnlyDrafts  15 drafts, nothing issued
 *   cus_sandboxBroken      every request fails with a 500
 *   cus_sandboxUnknown     does not exist (Stripe-style "No such customer")
 *   cus_sandboxHuge        2,500 issued invoices over ~7 years, 300 drafts mixed in
 *                          (numbers HUGE-0001 … HUGE-2500)
 *
 * `GET /v1/invoices` honours `status` and `created[gte|lte]` like Stripe does.
 *
 * Subscriptions (the dashboard's "Current plan"): sandbox.env configures
 * `price_sandboxPro` / `price_sandboxEnterprise` as the catalog's prices, so
 *   demo                                   → Pro ($29/month)
 *   drafts                                 → Pro, canceled in "Stripe" a moment ago while
 *                                            the stand-in's records still say active (the
 *                                            webhook lag after a Customer Portal action)
 *   canceled                               → Pro, ended 10 days ago
 *   huge                                   → Pro, set to cancel in 14 days
 *   empty                                  → Pro with a discount applied
 *   ambiguous                              → Enterprise ($99/month)
 *   other                                  → a price outside the catalog ("unrecognized")
 *   broken                                 → every request fails with a 500
 *   unknown                                → Stripe-style "No such subscription"
 */
import { createServer } from "node:http";

import { ACCOUNTS } from "./fake-supabase.mjs";

const DEFAULT_PORT = 4242;

export function startFakeStripe(port = DEFAULT_PORT) {
  const base = `http://127.0.0.1:${port}`;
  const { customers, invoices } = seed(base);
  /** Runtime failure switch: "none" | "list" | "retrieve" | "all". */
  let failMode = "none";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const json = (status, body, extra = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...extra });
      res.end(JSON.stringify(body));
    };
    const stripeError = (status, type, message, fields = {}) =>
      json(status, { error: { type, message, ...fields } });
    const missing = (param, id) =>
      stripeError(
        404,
        "invalid_request_error",
        `No such ${param === "customer" ? "customer" : "invoice"}: '${id}'`,
        {
          code: "resource_missing",
          param,
        },
      );

    // ---- sandbox controls and the documents Stripe would host (no API key) ----
    if (url.pathname === "/__sandbox") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(statusPage(base, customers, invoices, failMode));
      return;
    }

    if (url.pathname === "/__sandbox/fail") {
      const mode = url.searchParams.get("mode") ?? "none";
      if (!["none", "list", "retrieve", "all"].includes(mode)) {
        return json(400, { error: "mode must be none | list | retrieve | all" });
      }
      failMode = mode;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><title>sandbox Stripe</title><p>Failure mode is now <b>${mode}</b>.</p><p><a href="/__sandbox">Back</a></p>`,
      );
      return;
    }

    let m = url.pathname.match(/^\/i\/(in_[A-Za-z0-9]+)$/);
    if (m) {
      const invoice = invoices.get(m[1]);
      if (!invoice || invoice.status === "draft") {
        res
          .writeHead(404, { "Content-Type": "text/plain" })
          .end("No such hosted invoice page");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(hostedPage(invoice, base));
      return;
    }

    m = url.pathname.match(/^\/invoice\/(in_[A-Za-z0-9]+)\/pdf$/);
    if (m) {
      const invoice = invoices.get(m[1]);
      if (!invoice || invoice.status === "draft") {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("No such invoice PDF");
        return;
      }
      const pdf = minimalPdf([
        `Invoice ${invoice.number}`,
        `Customer ${invoice.customer}`,
        `Total ${(invoice.total / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
        `Status ${invoice.status}`,
        "Generated by the sandbox Stripe stand-in",
      ]);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoice.number}.pdf"`,
        "Content-Length": pdf.length,
      });
      res.end(pdf);
      return;
    }

    // ---- the API (requires a test key, like Stripe) ---------------------------
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer sk_test_")) {
      return stripeError(
        401,
        "invalid_request_error",
        "Invalid API Key provided (sandbox accepts any sk_test_ key)",
      );
    }

    if (url.pathname === "/v1/invoices" && req.method === "GET") {
      const customer = url.searchParams.get("customer");
      if (failMode === "list" || failMode === "all" || customer === "cus_sandboxBroken") {
        return stripeError(500, "api_error", "Sandbox: simulated Stripe outage");
      }
      if (!customer) {
        return stripeError(400, "invalid_request_error", "sandbox: customer is required");
      }
      if (!customers.has(customer)) return missing("customer", customer);

      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit") ?? 10)),
      );
      const status = url.searchParams.get("status");
      const gte = url.searchParams.get("created[gte]");
      const lte = url.searchParams.get("created[lte]");
      if (
        status &&
        !["draft", "open", "paid", "uncollectible", "void"].includes(status)
      ) {
        return stripeError(400, "invalid_request_error", `Invalid status: ${status}`, {
          param: "status",
        });
      }
      // Filters first, then paging through what is left — as Stripe does.
      const all = [...invoices.values()].filter(
        (i) =>
          i.customer === customer &&
          (!status || i.status === status) &&
          (!gte || i.created >= Number(gte)) &&
          (!lte || i.created <= Number(lte)),
      );
      const after = url.searchParams.get("starting_after");
      let start = 0;
      if (after) {
        const index = all.findIndex((i) => i.id === after);
        if (index === -1) return missing("starting_after", after);
        start = index + 1;
      }
      const data = all.slice(start, start + limit);
      return json(200, {
        object: "list",
        url: "/v1/invoices",
        has_more: start + data.length < all.length,
        data,
      });
    }

    m = url.pathname.match(/^\/v1\/invoices\/([^/]+)$/);
    if (m && req.method === "GET") {
      if (failMode === "retrieve" || failMode === "all") {
        return stripeError(500, "api_error", "Sandbox: simulated Stripe outage");
      }
      const invoice = invoices.get(m[1]);
      if (!invoice) return missing("id", m[1]);
      if (invoice.customer === "cus_sandboxBroken") {
        return stripeError(500, "api_error", "Sandbox: simulated Stripe outage");
      }
      return json(200, invoice);
    }

    m = url.pathname.match(/^\/v1\/customers\/([^/]+)$/);
    if (m && req.method === "GET") {
      const customer = customers.get(m[1]);
      return customer ? json(200, customer) : missing("customer", m[1]);
    }

    m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (m && req.method === "GET") {
      if (failMode === "retrieve" || failMode === "all") {
        return stripeError(500, "api_error", "Sandbox: simulated Stripe outage");
      }
      const subscription = subscriptionOf(m[1]);
      if (!subscription) {
        return stripeError(
          404,
          "invalid_request_error",
          `No such subscription: '${m[1]}'`,
          {
            code: "resource_missing",
            param: "id",
          },
        );
      }
      if (subscription.customer === "cus_sandboxBroken") {
        return stripeError(500, "api_error", "Sandbox: simulated Stripe outage");
      }
      return json(200, subscription);
    }

    if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      return json(200, {
        id: "cs_sandbox",
        object: "checkout.session",
        mode: body.get("mode"),
        customer: body.get("customer"),
        client_reference_id: body.get("client_reference_id"),
        // Must be https for the action to follow it; unreachable offline by design.
        url: "https://checkout.stripe.com/c/pay/sandbox_not_reachable_offline",
      });
    }

    if (url.pathname === "/v1/billing_portal/sessions" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      const customer = body.get("customer");
      if (!customers.has(customer)) return missing("customer", customer);
      return json(200, {
        id: "bps_sandbox",
        object: "billing_portal.session",
        customer,
        return_url: body.get("return_url"),
        // Must be https for the action to follow it; unreachable offline by design.
        url: "https://billing.stripe.com/p/session/sandbox_not_reachable_offline",
      });
    }

    stripeError(
      404,
      "invalid_request_error",
      `sandbox Stripe: no route for ${req.method} ${url.pathname}`,
    );
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// ---- data --------------------------------------------------------------------

/** Which price each sandbox account's subscription is on (see the header). */
const PRICE_OF_ACCOUNT = {
  ambiguous: { id: "price_sandboxEnterprise", unit_amount: 9900 },
  other: { id: "price_sandboxLegacy", unit_amount: 1900 },
};
const DEFAULT_PRICE = { id: "price_sandboxPro", unit_amount: 2900 };

/**
 * The subscription object for one of the ids the Supabase stand-in seeds
 * (`sub_sandbox<account><n>`, pointing at `ACCOUNTS[<account>@example.com][n]`).
 * Anything else does not exist.
 */
function subscriptionOf(id) {
  const m = id.match(/^sub_sandbox([a-z]+)(\d+)$/);
  if (!m) return null;
  const [, account, index] = m;
  // Like its customer, this account's subscription does not exist in "Stripe".
  if (account === "unknown") return null;
  const link = ACCOUNTS[`${account}@example.com`]?.[Number(index)];
  if (!link) return null;
  const [customer, recordedStatus] = link;
  const price = PRICE_OF_ACCOUNT[account] ?? DEFAULT_PRICE;
  const now = Math.floor(Date.now() / 1000);
  // Stripe is ahead of the records for `drafts`: canceled just now.
  const status = account === "drafts" ? "canceled" : recordedStatus;
  const ended = status === "canceled";
  const scheduled = account === "huge";
  return {
    id,
    object: "subscription",
    customer,
    status,
    livemode: false,
    cancel_at_period_end: scheduled,
    cancel_at: scheduled ? now + 14 * 86_400 : null,
    canceled_at: ended
      ? now - (account === "drafts" ? 60 : 11 * 86_400)
      : scheduled
        ? now - 86_400
        : null,
    ended_at: ended ? now - (account === "drafts" ? 60 : 10 * 86_400) : null,
    // Ids only, as Stripe answers without `expand`.
    discounts: account === "empty" ? ["di_sandboxWelcome"] : [],
    metadata: { planId: "pro" }, // stale on purpose: the app must read the price
    items: {
      object: "list",
      data: [
        {
          id: `si_${id.slice(4)}`,
          object: "subscription_item",
          quantity: 1,
          discounts: [],
          price: {
            id: price.id,
            object: "price",
            unit_amount: price.unit_amount,
            currency: "usd",
            billing_scheme: "per_unit",
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
  };
}

function seed(base) {
  const customers = new Map();
  /** Insertion order = Stripe's list order (newest first). */
  const invoices = new Map();
  const now = Math.floor(Date.now() / 1000);
  let serial = 0;

  const addCustomer = (id, email) =>
    customers.set(id, { id, object: "customer", email, livemode: false });

  const addInvoice = (customer, fields) => {
    const n = ++serial;
    const id = `in_sandbox${String(n).padStart(4, "0")}`;
    const issued = fields.status !== "draft";
    const invoice = {
      id,
      object: "invoice",
      customer,
      created: now - n * 86_400, // one per day, newest first in insertion order
      currency: "usd",
      total: 2900,
      amount_due: 2900,
      amount_paid: fields.status === "paid" ? 2900 : 0,
      number: issued ? `SANDBOX-${String(n).padStart(4, "0")}` : null,
      hosted_invoice_url: issued ? `${base}/i/${id}` : null,
      invoice_pdf: issued ? `${base}/invoice/${id}/pdf` : null,
      livemode: false,
      ...fields,
    };
    invoices.set(id, invoice);
    return invoice;
  };

  addCustomer("cus_sandboxDemo", "demo@example.com");
  addCustomer("cus_sandboxOther", "other@example.com");
  addCustomer("cus_sandboxEmpty", "empty@example.com");
  addCustomer("cus_sandboxOnlyDrafts", "drafts@example.com");
  addCustomer("cus_sandboxBroken", "broken@example.com");
  addCustomer("cus_sandboxHuge", "huge@example.com");

  // Demo: 12 drafts FIRST (newest), then 25 issued invoices — the shape that
  // used to make the history look empty.
  for (let i = 0; i < 12; i++)
    addInvoice("cus_sandboxDemo", { status: "draft", total: 100 });

  const statuses = [
    "paid",
    "paid",
    "paid",
    "open",
    "paid",
    "paid",
    "void",
    "paid",
    "paid",
    "uncollectible",
  ];
  const currencies = ["usd", "usd", "eur", "gbp", "jpy", "usd"];
  for (let i = 0; i < 25; i++) {
    const currency = currencies[i % currencies.length];
    const fields = {
      status: statuses[i % statuses.length],
      currency,
      total: currency === "jpy" ? 2900 + i * 100 : 2900 + i * 125,
    };
    if (i === 1 || i === 7) fields.invoice_pdf = null; // PDF not (yet) available
    if (i === 2) fields.hosted_invoice_url = "https://evil.example/i/not-stripe"; // rejected
    if (i === 4) fields.invoice_pdf = "not a url"; // rejected
    addInvoice("cus_sandboxDemo", fields);
  }

  for (let i = 0; i < 3; i++) addInvoice("cus_sandboxOther", { status: "paid" });

  // Huge: 2,800 objects, one per day going back ~7.7 years; every ~9th is a
  // draft, statuses and currencies vary, numbers are HUGE-0001 (newest) upward.
  let hugeSerial = 0;
  for (let i = 0; i < 2800; i++) {
    const draft = i % 9 === 4;
    const n = draft ? null : ++hugeSerial;
    addInvoice("cus_sandboxHuge", {
      status: draft
        ? "draft"
        : ["paid", "paid", "paid", "open", "void", "uncollectible"][i % 6],
      currency: ["usd", "eur", "gbp"][i % 3],
      total: 1000 + (i % 50) * 100,
      number: n === null ? null : `HUGE-${String(n).padStart(4, "0")}`,
    });
  }
  for (let i = 0; i < 15; i++) addInvoice("cus_sandboxOnlyDrafts", { status: "draft" });
  for (let i = 0; i < 2; i++) addInvoice("cus_sandboxBroken", { status: "paid" });

  return { customers, invoices };
}

// ---- pages -------------------------------------------------------------------

function hostedPage(invoice, base) {
  const amount = (invoice.total / (invoice.currency === "jpy" ? 1 : 100)).toFixed(
    invoice.currency === "jpy" ? 0 : 2,
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice ${invoice.number} (sandbox)</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}
.tag{display:inline-block;padding:.2rem .5rem;border-radius:.4rem;background:#eee}</style></head>
<body>
<p class="tag">sandbox Stripe stand-in — hosted invoice page</p>
<h1>Invoice ${invoice.number}</h1>
<dl>
<dt>Customer</dt><dd>${invoice.customer}</dd>
<dt>Status</dt><dd>${invoice.status}</dd>
<dt>Total</dt><dd>${amount} ${invoice.currency.toUpperCase()}</dd>
<dt>Created</dt><dd>${new Date(invoice.created * 1000).toISOString()}</dd>
</dl>
<p><a href="${base}/invoice/${invoice.id}/pdf">Download PDF</a></p>
</body></html>`;
}

function statusPage(base, customers, invoices, failMode) {
  const rows = [...customers.keys()]
    .map((c) => {
      const all = [...invoices.values()].filter((i) => i.customer === c);
      const drafts = all.filter((i) => i.status === "draft").length;
      return `<tr><td>${c}</td><td>${all.length - drafts}</td><td>${drafts}</td></tr>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>sandbox Stripe</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}td,th{padding:.2rem .8rem;text-align:left}</style></head>
<body><h1>sandbox Stripe stand-in</h1>
<p>Base URL: <code>${base}</code> · failure mode: <b>${failMode}</b></p>
<p>Switch failures:
<a href="/__sandbox/fail?mode=none">none</a> ·
<a href="/__sandbox/fail?mode=list">list</a> (invoice list fails) ·
<a href="/__sandbox/fail?mode=retrieve">retrieve</a> (documents fail) ·
<a href="/__sandbox/fail?mode=all">all</a></p>
<table><tr><th>Customer</th><th>Issued</th><th>Drafts</th></tr>${rows}</table>
<p><code>cus_sandboxUnknown</code> does not exist, and every call for <code>cus_sandboxBroken</code> fails.</p>
</body></html>`;
}

/** A minimal, valid single-page PDF showing the given lines of text. */
export function minimalPdf(lines) {
  const escaped = lines.map((l) => l.replace(/[\\()]/g, (c) => `\\${c}`));
  const content = [
    "BT",
    "/F1 14 Tf",
    "50 740 Td",
    "18 TL",
    ...escaped.map((l) => `(${l}) Tj T*`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.SANDBOX_STRIPE_PORT ?? DEFAULT_PORT);
  await startFakeStripe(port);
  console.log(
    `sandbox Stripe listening on http://127.0.0.1:${port}  (status: /__sandbox)`,
  );
}
