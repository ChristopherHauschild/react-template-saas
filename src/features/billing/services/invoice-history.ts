/**
 * What the billing page shows about a user's invoices — and nothing more.
 *
 * This module is pure: it turns what Stripe answered into the display model and
 * formats it. Talking to Stripe (and deciding WHICH customer to ask about) is
 * `getInvoiceHistory`. Like `BillingSummary`, the display model crosses into
 * components, so it carries no Stripe identifiers: not the customer id the list
 * was fetched for, and not the `in_…` invoice ids as such. The customer-facing
 * invoice number (`ABCD-0001`) is the only reference shown; the `key` of each
 * invoice is an opaque token (see `encodeInvoiceKey`), and so are the paging
 * cursors (`invoice-cursor.ts`).
 */

/**
 * Stripe invoice statuses the page lists. `draft` is deliberately absent: a
 * draft is not an invoice yet (its amount may still change, and the customer
 * has not been billed), so drafts are dropped from the list — as the Customer
 * Portal does.
 */
export const LISTED_INVOICE_STATUSES = ["open", "paid", "uncollectible", "void"] as const;

export type ListedInvoiceStatus = (typeof LISTED_INVOICE_STATUSES)[number];

/** Statuses the page can display: Stripe's, plus one for a value we do not know. */
export type InvoiceDisplayStatus = ListedInvoiceStatus | "unknown";

export function isListedInvoiceStatus(value: unknown): value is ListedInvoiceStatus {
  return (
    typeof value === "string" &&
    (LISTED_INVOICE_STATUSES as readonly string[]).includes(value)
  );
}

export type InvoiceSummary = {
  /**
   * Opaque, stable identity of the invoice for the UI: React keys, dropping a
   * duplicate when pages are appended, and the document links. An encoding of
   * Stripe's id, never shown as such; see `encodeInvoiceKey`.
   */
  key: string;
  /**
   * Stripe's customer-facing invoice number (`ABCD-0001`). `null` when Stripe
   * has not assigned one (it is assigned at finalization).
   */
  number: string | null;
  /** When Stripe created the invoice, as an ISO 8601 timestamp in UTC. */
  createdAt: string;
  /**
   * The invoice's total — after discounts and tax, before any customer credit
   * balance — in the currency's minor unit (cents for USD), exactly as Stripe
   * reports it. `formatInvoiceAmount` turns it into text.
   */
  total: number;
  /** Lower-case ISO 4217 code, as Stripe reports it. */
  currency: string;
  /**
   * Stripe's status, or `"unknown"` for a value this code does not know (Stripe
   * may add statuses; an unknown one is shown as such, never guessed at).
   */
  status: InvoiceDisplayStatus;
  /**
   * Which documents Stripe makes available for this invoice: the hosted
   * invoice page (`view`) and the PDF (`pdf`). `false` until Stripe provides a
   * usable URL (see `isInvoiceDocumentUrl`). The URLs themselves never reach
   * the UI: a document is opened through `invoiceDocumentPath`, which fetches
   * the current URL for the signed-in user at click time.
   */
  documents: Record<InvoiceDocumentKind, boolean>;
};

// --- documents ----------------------------------------------------------------

/** The two documents Stripe provides for an issued invoice, by their URL path segment. */
export const INVOICE_DOCUMENT_KINDS = ["view", "pdf"] as const;

export type InvoiceDocumentKind = (typeof INVOICE_DOCUMENT_KINDS)[number];

export function isInvoiceDocumentKind(value: unknown): value is InvoiceDocumentKind {
  return (
    typeof value === "string" &&
    (INVOICE_DOCUMENT_KINDS as readonly string[]).includes(value)
  );
}

/** Stripe's field holding each document's URL on the invoice object. */
export const INVOICE_DOCUMENT_FIELDS: Record<InvoiceDocumentKind, string> = {
  view: "hosted_invoice_url",
  pdf: "invoice_pdf",
};

/** Same-origin path that opens a document for the signed-in user (a route handler redirects to Stripe). */
export function invoiceDocumentPath(key: string, kind: InvoiceDocumentKind): string {
  return `/billing/invoices/${encodeURIComponent(key)}/${kind}`;
}

/**
 * Hosts Stripe serves invoice documents from. Hosted invoice pages and PDFs
 * live on `invoice.stripe.com` / `pay.stripe.com`; any `*.stripe.com` host is
 * accepted so a move between Stripe subdomains does not break links.
 */
const STRIPE_DOCUMENT_HOST = /^(?:[a-z0-9-]+\.)*stripe\.com$/i;

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * Whether a value is a URL this application will send a user to as an invoice
 * document: an absolute `https:` URL on a Stripe host, or on one of
 * `extraHosts` (for a custom invoice domain configured in Stripe, or a Stripe
 * stand-in in development — a loopback host among them may use `http:`).
 * Anything else — a relative path, another scheme, another host, a string that
 * is not a URL — is treated as "no document" and never followed.
 */
export function isInvoiceDocumentUrl(
  value: unknown,
  extraHosts: readonly string[] = [],
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048)
    return false;

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const extra = extraHosts.some((h) => h.toLowerCase() === host);

  if (url.protocol === "https:") return extra || STRIPE_DOCUMENT_HOST.test(host);
  if (url.protocol === "http:") return extra && LOOPBACK_HOST.test(host);

  return false;
}

// --- paging -------------------------------------------------------------------

/**
 * How many ISSUED invoices one page shows. Drafts do not count: a page is
 * filled by scanning forward through Stripe's list (newest first) until this
 * many non-draft invoices are in hand or the list is exhausted, so a run of
 * drafts can neither hide older invoices nor produce a falsely empty page.
 */
export const INVOICE_HISTORY_PAGE_SIZE = 10;

/**
 * How many objects one request to Stripe asks for while filling a page. Larger
 * than the page so one request normally suffices even with drafts in between;
 * well below Stripe's maximum of 100 because invoice objects are large.
 */
export const INVOICE_FETCH_BATCH_SIZE = 50;

/**
 * Upper bound on requests to Stripe for ONE page — a safety valve, so that a
 * customer with an absurd run of drafts cannot keep a request scanning. When
 * it is reached the page is returned as is (possibly short, even empty) with a
 * cursor past everything examined, and the UI offers to continue. Over
 * `INVOICE_FETCH_BATCH_SIZE * INVOICE_MAX_FETCHES_PER_PAGE` consecutive drafts
 * would be needed to notice it.
 */
export const INVOICE_MAX_FETCHES_PER_PAGE = 6;

/**
 * Budget for ONE page of a number search, which Stripe cannot narrow down: the
 * scan reads Stripe's maximum batch and more of them, so each click covers up
 * to `INVOICE_SEARCH_BATCH_SIZE * INVOICE_SEARCH_MAX_FETCHES_PER_PAGE`
 * invoices of history; the UI shows how far a search got and lets it go on.
 */
export const INVOICE_SEARCH_BATCH_SIZE = 100;

export const INVOICE_SEARCH_MAX_FETCHES_PER_PAGE = 10;

/** Stripe invoice ids are `in_` followed by alphanumerics. */
const STRIPE_INVOICE_ID = /^in_[A-Za-z0-9]+$/;

export function isStripeInvoiceId(value: unknown): value is string {
  return typeof value === "string" && STRIPE_INVOICE_ID.test(value);
}

/**
 * Turns a Stripe invoice id into the opaque token used as an invoice's `key`
 * (React keys, de-duplication, the document links). Not a secret and not a
 * protection: its job is to keep Stripe's identifiers out of the markup and
 * the client out of Stripe's id format. What protects documents is that the
 * server decodes the token (`decodeInvoiceKey`, which accepts nothing but a
 * well-formed invoice id) and then checks the invoice against the customer
 * resolved from the user's own records — a forged or foreign key opens nothing.
 */
export function encodeInvoiceKey(invoiceId: string): string {
  return encodeToken(invoiceId);
}

/** Inverse of `encodeInvoiceKey`; `null` for anything that is not a token for a well-formed invoice id. */
export function decodeInvoiceKey(key: unknown): string | null {
  const id = decodeToken(key, 64);

  return id !== null && isStripeInvoiceId(id) && encodeInvoiceKey(id) === key ? id : null;
}

/** base64url of ASCII text; `btoa`/`atob` exist in Node and browsers alike. */
export function encodeToken(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of `encodeToken`; `null` unless `token` is a base64url string of at most `maxLength`. */
export function decodeToken(token: unknown, maxLength: number): string | null {
  if (typeof token !== "string" || token.length === 0 || token.length > maxLength)
    return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

  try {
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
}

/**
 * What the list says when a "load more" request fails. `retry`: the rows on
 * screen stay and the same page can be asked for again. `restart`: the cursor
 * or the records are no longer valid, so only a reload from the top helps.
 */
export const LOAD_MORE_INVOICES_COPY = {
  retry: "We couldn't load more invoices. Please try again in a moment.",
  restart: "Your invoice list is out of date. Reload the page to see the current list.",
} as const;

/** One page of issued invoices, as the page and the "load more" action hand it to the UI. */
export type InvoicePage = {
  /** The invoices of this page that satisfy the filters. */
  invoices: InvoiceSummary[];
  /**
   * Cursor for the page after this one — it carries the filters, so the next
   * page continues the same listing; `null` when Stripe has nothing further.
   */
  nextCursor: string | null;
  /**
   * How many objects Stripe handed over for this page (drafts and non-matching
   * invoices included): what the page "looked at", so a search can say how
   * far it got.
   */
  examined: number;
};

/**
 * Appends a page to the invoices already shown, dropping any invoice whose key
 * is already present. Pages from Stripe do not overlap, but a retried or
 * duplicated request (double click, a response that arrives twice) must not
 * show an invoice twice. Order: existing first, then the new ones in their
 * own order.
 */
export function appendInvoices(
  existing: readonly InvoiceSummary[],
  incoming: readonly InvoiceSummary[],
): InvoiceSummary[] {
  const seen = new Set(existing.map((invoice) => invoice.key));
  const added: InvoiceSummary[] = [];

  for (const invoice of incoming) {
    if (seen.has(invoice.key)) continue;
    seen.add(invoice.key);
    added.push(invoice);
  }

  return added.length === 0 ? [...existing] : [...existing, ...added];
}

export type InvoiceListReading =
  | {
      ok: true;
      /** The issued invoices of this batch, in Stripe's order (newest first). */
      invoices: InvoiceSummary[];
      /** Stripe ids of `invoices`, same order (for cursors; never part of the display model). */
      ids: string[];
      /** Position of each of `invoices` in the batch (drafts counted), same order. */
      positions: number[];
      /** Stripe's `has_more`: objects exist after the last one of this batch (drafts included). */
      hasMore: boolean;
      /** Stripe id of the last object in the batch — draft or not — i.e. where the scan got to. `null` for an empty batch. */
      lastId: string | null;
      /** How many objects the batch held, drafts included. */
      received: number;
      /** Document URLs that were present but not usable (see `isInvoiceDocumentUrl`); for the log. */
      rejectedDocumentUrls: number;
    }
  /** Stripe's answer was refused. `reason` is for logs and tests; no data from the answer is kept. */
  | {
      ok: false;
      reason: /** Not a list object with an array of invoices. */
        | "not_a_list"
        /** An entry is not an object with the fields an invoice has. */
        | "malformed_invoice"
        /** An entry belongs to another customer than the one asked about. */
        | "foreign_customer"
        /** The same invoice appears twice in one batch. */
        | "duplicate_invoice";
    };

/**
 * Reads one batch of a Stripe invoice list (`GET /v1/invoices?customer=…`)
 * into the display model, trusting nothing about its shape. The whole answer
 * is refused — not just the offending entry — if any invoice is malformed,
 * duplicated, or names another customer: the list was requested for one
 * customer, so an entry for a different one means the answer cannot be what
 * was asked for, and a list with holes would misreport the user's history.
 *
 * Drafts are dropped from `invoices` (see `LISTED_INVOICE_STATUSES`) but still
 * advance `lastId`, so a caller paging by it never re-reads or skips them.
 * Stripe's order (newest first) is kept.
 */
export type ReadInvoiceListOptions = {
  /** Extra hosts a document URL may point at; see `isInvoiceDocumentUrl`. */
  documentHosts?: readonly string[];
};

export function readInvoiceList(
  answer: unknown,
  expectedCustomer: string,
  options: ReadInvoiceListOptions = {},
): InvoiceListReading {
  if (answer === null || typeof answer !== "object") {
    return { ok: false, reason: "not_a_list" };
  }

  const { data, has_more } = answer as { data?: unknown; has_more?: unknown };

  if (!Array.isArray(data)) return { ok: false, reason: "not_a_list" };

  const invoices: InvoiceSummary[] = [];
  const listedIds: string[] = [];
  const positions: number[] = [];
  const ids = new Set<string>();
  let lastId: string | null = null;
  let rejectedDocumentUrls = 0;

  for (const [position, entry] of data.entries()) {
    if (entry === null || typeof entry !== "object") {
      return { ok: false, reason: "malformed_invoice" };
    }

    const invoice = entry as Record<string, unknown>;

    if (!namesCustomer(invoice.customer, expectedCustomer)) {
      return { ok: false, reason: "foreign_customer" };
    }

    const { id, created, total, currency, number, status } = invoice;

    if (
      !isStripeInvoiceId(id) ||
      !isUnixSeconds(created) ||
      !Number.isSafeInteger(total) ||
      !isCurrencyCode(currency) ||
      !(number === null || number === undefined || typeof number === "string") ||
      !(status === null || status === undefined || typeof status === "string")
    ) {
      return { ok: false, reason: "malformed_invoice" };
    }

    if (ids.has(id)) return { ok: false, reason: "duplicate_invoice" };
    ids.add(id);
    lastId = id;

    if (status === "draft") continue;

    const documents = {} as Record<InvoiceDocumentKind, boolean>;

    for (const kind of INVOICE_DOCUMENT_KINDS) {
      const url = invoice[INVOICE_DOCUMENT_FIELDS[kind]];
      const usable = isInvoiceDocumentUrl(url, options.documentHosts);

      // Absent (`null`/`undefined`) is Stripe saying "not yet"; anything else
      // that is not usable is counted, so a misconfiguration shows in the log.
      if (!usable && url !== null && url !== undefined) rejectedDocumentUrls++;
      documents[kind] = usable;
    }

    listedIds.push(id);
    positions.push(position);
    invoices.push({
      key: encodeInvoiceKey(id),
      number: typeof number === "string" && number.length > 0 ? number : null,
      createdAt: new Date(created * 1000).toISOString(),
      total: total as number,
      currency: currency.toLowerCase(),
      status: isListedInvoiceStatus(status) ? status : "unknown",
      documents,
    });
  }

  return {
    ok: true,
    invoices,
    ids: listedIds,
    positions,
    hasMore: has_more === true,
    lastId,
    received: data.length,
    rejectedDocumentUrls,
  };
}

/** `customer` is an id in a plain list, an object when expanded; both must name the expected one. */
export function namesCustomer(customer: unknown, expected: string): boolean {
  if (typeof customer === "string") return customer === expected;

  return (
    customer !== null &&
    typeof customer === "object" &&
    (customer as { id?: unknown }).id === expected
  );
}

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value);
}

// --- display ------------------------------------------------------------------

export type InvoiceStatusContent = {
  /** Short label for the status pill. */
  label: string;
  /** `attention` = money is owed or was written off; `neutral` otherwise. */
  tone: "neutral" | "attention";
};

export const INVOICE_STATUS_CONTENT: Record<InvoiceDisplayStatus, InvoiceStatusContent> =
  {
    paid: { label: "Paid", tone: "neutral" },
    open: { label: "Open", tone: "attention" },
    uncollectible: { label: "Uncollectible", tone: "attention" },
    void: { label: "Void", tone: "neutral" },
    unknown: { label: "Unknown", tone: "attention" },
  };

/**
 * Currencies whose Stripe amounts are NOT in hundredths. Stripe's list, not ISO
 * 4217's: Stripe's API treats ISK, HUF, TWD and UGX as two-decimal even where
 * ISO does not (its "special cases"), so `Intl`'s own fraction digits cannot be
 * used to scale the amount, and UGX is deliberately not in this set.
 * https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Number of minor-unit digits Stripe uses for a currency. */
export function minorUnitDigits(currency: string): number {
  const code = currency.toLowerCase();

  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;

  return 2;
}

/**
 * Formats a Stripe amount (minor units) as currency text, e.g. `2900` + `usd`
 * → `$29.00`, `2900` + `jpy` → `¥2,900`. A fixed locale keeps server and client
 * output identical. A currency `Intl` cannot format (malformed or unknown
 * code) falls back to the scaled number followed by the code — the amount must
 * never be dropped or thrown over.
 */
export function formatInvoiceAmount(total: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  const amount = total / 10 ** digits;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

/**
 * Formats an invoice's creation timestamp as a date, e.g. `Mar 1, 2026`. The
 * UTC calendar date is used (Stripe's own invoice documents do the same), so
 * the text does not depend on the server's time zone.
 */
export function formatInvoiceDate(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(createdAt));
}
