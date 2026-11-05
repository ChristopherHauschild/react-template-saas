#!/usr/bin/env node
/**
 * DEVELOPMENT ONLY. Creates invoices on a Stripe TEST customer so the billing
 * page's invoice history and its paging can be exercised in a browser without
 * waiting for subscription renewals.
 *
 * Usage (reads STRIPE_SECRET_KEY from .env.local):
 *
 *   node --env-file=.env.local scripts/seed-stripe-invoices.mjs --create-customer you@example.com
 *   node --env-file=.env.local scripts/seed-stripe-invoices.mjs --customer cus_xxx [--issued 25] [--drafts 12]
 *
 * What it creates, oldest first (Stripe lists newest first, so the DRAFTS end
 * up at the top of the list — the situation that used to hide older invoices):
 *   1. `--issued` finalized invoices: mostly paid (out of band, no card needed),
 *      with one open, one void and one uncollectible among every ten;
 *   2. `--drafts` invoices left as drafts (never finalized).
 *
 * Refuses anything but a test-mode key. Each run adds to what is already there;
 * delete the customer in the Stripe Dashboard to start over.
 */
import Stripe from "stripe";

const args = parseArgs(process.argv.slice(2));
const key = process.env.STRIPE_SECRET_KEY ?? "";

if (!key.startsWith("sk_test_")) {
  fail(
    "STRIPE_SECRET_KEY must be a Stripe TEST secret key (sk_test_…). Run with\n" +
      "  node --env-file=.env.local scripts/seed-stripe-invoices.mjs …\n" +
      "and never point this script at a live account.",
  );
}

const stripe = new Stripe(key, { apiVersion: "2026-02-25.clover" });

if (args["create-customer"]) {
  const customer = await stripe.customers.create({
    email: String(args["create-customer"]),
    description: "Local invoice-history testing (react-template-saas)",
  });
  console.log(`Created test customer ${customer.id} for ${customer.email}.`);
  console.log(
    `Next: bash scripts/link-local-customer.sh ${customer.email} ${customer.id}\n` +
      `      node --env-file=.env.local scripts/seed-stripe-invoices.mjs --customer ${customer.id}`,
  );
  process.exit(0);
}

const customer = String(args.customer ?? "");
const issued = Number(args.issued ?? 25);
const drafts = Number(args.drafts ?? 12);

if (!/^cus_[A-Za-z0-9]+$/.test(customer)) {
  fail("Pass --customer cus_… (or --create-customer <email> to make one).");
}
if (!Number.isInteger(issued) || issued < 0 || !Number.isInteger(drafts) || drafts < 0) {
  fail("--issued and --drafts must be non-negative integers.");
}

await stripe.customers.retrieve(customer); // fails fast on an unknown / live-mode id

console.log(`Seeding ${issued} issued + ${drafts} draft invoices on ${customer}…`);

const CURRENCIES = ["usd", "usd", "usd", "eur", "gbp", "jpy"];

for (let i = 0; i < issued; i++) {
  const currency = CURRENCIES[i % CURRENCIES.length];
  const amount = currency === "jpy" ? 2900 + i * 100 : 2900 + i * 25;
  const invoice = await createInvoice(
    customer,
    amount,
    currency,
    `Seeded invoice #${i + 1}`,
  );
  await stripe.invoices.finalizeInvoice(invoice.id);

  // A little variety: positions 3, 6 and 9 of every ten are open / void / uncollectible.
  const slot = i % 10;
  let status;
  if (slot === 3) {
    status = "open";
  } else if (slot === 6) {
    await stripe.invoices.voidInvoice(invoice.id);
    status = "void";
  } else if (slot === 9) {
    await stripe.invoices.markUncollectible(invoice.id);
    status = "uncollectible";
  } else {
    await stripe.invoices.pay(invoice.id, { paid_out_of_band: true });
    status = "paid";
  }

  process.stdout.write(`  issued ${String(i + 1).padStart(3)}/${issued}  ${status}\n`);
}

for (let i = 0; i < drafts; i++) {
  await createInvoice(customer, 100, "usd", `Seeded draft #${i + 1}`);
  process.stdout.write(`  draft  ${String(i + 1).padStart(3)}/${drafts}\n`);
}

console.log("Done. Open http://127.0.0.1:3000/billing as the linked user.");

// ------------------------------------------------------------------------------

async function createInvoice(customer, amount, currency, description) {
  const invoice = await stripe.invoices.create({
    customer,
    // `send_invoice` keeps Stripe from trying to charge a card that does not
    // exist; `auto_advance: false` leaves the invoice a draft until finalized.
    collection_method: "send_invoice",
    days_until_due: 30,
    auto_advance: false,
    // In this API version the default is already `exclude`; stated so a stray
    // pending item on the customer is never swept into a seeded invoice.
    pending_invoice_items_behavior: "exclude",
    description,
  });

  // An invoice needs at least one line to be finalized; attach it explicitly
  // to this draft rather than leaving it pending on the customer.
  await stripe.invoiceItems.create({
    customer,
    invoice: invoice.id,
    amount,
    currency,
    description,
  });

  return invoice;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      out[name] = true;
    } else {
      out[name] = value;
      i++;
    }
  }
  return out;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
