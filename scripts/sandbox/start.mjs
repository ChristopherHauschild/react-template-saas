/**
 * SANDBOX ONLY. Starts the Supabase and Stripe stand-ins and then `next dev`
 * against them, all in one command:
 *
 *   npm run sandbox            (loads scripts/sandbox/sandbox.env)
 *
 * Stop with Ctrl-C. Ports: app 3000, Supabase stand-in 54321, Stripe stand-in
 * 4242 (override with PORT, SANDBOX_SUPABASE_PORT, SANDBOX_STRIPE_PORT — then
 * adjust the URLs in sandbox.env to match).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { startFakeStripe } from "./fake-stripe.mjs";
import { ACCOUNTS, PASSWORD, startFakeSupabase } from "./fake-supabase.mjs";

const supabasePort = Number(process.env.SANDBOX_SUPABASE_PORT ?? 54321);
const stripePort = Number(process.env.SANDBOX_STRIPE_PORT ?? 4242);
const appPort = Number(process.env.PORT ?? 3000);

if (
  !process.env.STRIPE_API_BASE_URL ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1")
) {
  console.error(
    "The sandbox env is not loaded. Run it as\n" +
      "  node --env-file=scripts/sandbox/sandbox.env scripts/sandbox/start.mjs\n" +
      "or simply `npm run sandbox`.",
  );
  process.exit(1);
}

await startFakeSupabase(supabasePort);
await startFakeStripe(stripePort);

console.log(`
sandbox Supabase  http://127.0.0.1:${supabasePort}   (reset export rate limits: /__sandbox/rate-limits/reset; Support at /support)
sandbox Stripe    http://127.0.0.1:${stripePort}   (status + failure switches: /__sandbox)

Accounts (password "${PASSWORD}"):
${Object.entries(ACCOUNTS)
  .map(
    ([email, links]) =>
      `  ${email.padEnd(24)} ${links.length === 0 ? "no billing account" : links.map(([c, s]) => `${c} (${s})`).join(", ")}`,
  )
  .join("\n")}

Starting next dev on http://127.0.0.1:${appPort} …
`);

const require = createRequire(import.meta.url);
const next = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    "dev",
    "--port",
    String(appPort),
    "--hostname",
    "127.0.0.1",
  ],
  { stdio: "inherit", env: process.env },
);

const stop = () => {
  next.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
next.on("exit", (code) => process.exit(code ?? 0));
