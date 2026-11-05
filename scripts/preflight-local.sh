#!/usr/bin/env bash
# Checks whether this machine can run the app against a LOCAL Supabase stack
# (needed to exercise sign-up, sign-in and the /settings page in a browser).
# Read-only: installs nothing, changes nothing, prints no secrets.
#
#   npm run preflight
#
# Exit code 0 = everything needed is present; 1 = something blocking is missing.
set -u
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; blocking=1; }
blocking=0

echo "Node / npm"
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 20 ]; then ok "node $(node --version)"; else fail "node $(node --version) — 20+ required"; fi
else
  fail "node not found"
fi
[ -d node_modules ] && ok "node_modules present" || fail "node_modules missing — run: npm ci"

echo "Supabase CLI (the project pins it as a devDependency; 'npx supabase' runs it)"
if [ -x node_modules/.bin/supabase ]; then
  ok "npx supabase → $(node_modules/.bin/supabase --version 2>/dev/null || echo '?')"
elif command -v supabase >/dev/null; then
  ok "global supabase → $(supabase --version 2>/dev/null || echo '?')"
else
  fail "supabase CLI not found — run: npm ci"
fi

echo "Helper tools"
command -v python3 >/dev/null \
  && ok "python3 (npm run env:local writes the local keys into .env.local)" \
  || warn "python3 not found — npm run env:local needs it; otherwise copy the keys from 'npx supabase status' into .env.local by hand"
command -v psql >/dev/null \
  && ok "psql (bash scripts/bootstrap-local-db.sh creates the local subscriptions table)" \
  || warn "psql not found — bash scripts/bootstrap-local-db.sh needs it (Billing and invoice exports); install the PostgreSQL client"

echo "Container runtime (supabase start runs Postgres, Auth, Studio, mail catcher as containers)"
if command -v docker >/dev/null; then
  if docker info >/dev/null 2>&1; then ok "docker daemon reachable"; else fail "docker CLI found but the daemon is not running / not reachable — start Docker Desktop (or: sudo systemctl start docker)"; fi
elif command -v podman >/dev/null; then
  if podman info >/dev/null 2>&1; then ok "podman reachable"; else fail "podman found but not usable (podman info failed)"; fi
else
  fail "neither docker nor podman on PATH — install Docker Desktop / Docker Engine / Podman"
fi

echo "Registry egress (images come from public.ecr.aws on first start)"
if command -v curl >/dev/null; then
  # curl prints 000 when the connection fails; any real HTTP status means the host is reachable.
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://public.ecr.aws/ 2>/dev/null)
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    fail "public.ecr.aws unreachable — images cannot be pulled from this network"
  else
    ok "public.ecr.aws reachable (HTTP $code)"
  fi
else
  warn "curl not found — could not test registry egress"
fi

echo "Ports the stack and the app need"
for port in 3000 54321 54322 54323 54324; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    exec 3>&- 3<&-
    if [ "$port" = 3000 ]; then warn "port $port already in use (is the app already running?)"; else warn "port $port already in use (a previous stack, or another Postgres?)"; fi
  else
    ok "port $port free"
  fi
done

echo ".env.local"
if [ -f .env.local ]; then
  if grep -q 'PLACEHOLDER' .env.local; then
    warn ".env.local still holds the dummy placeholders — after 'supabase start', run: npm run env:local"
  else
    ok ".env.local has non-placeholder Supabase values"
  fi
  grep -q '^NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000' .env.local \
    && ok "NEXT_PUBLIC_APP_URL is http://127.0.0.1:3000 (matches supabase/config.toml redirect allow-list)" \
    || warn "NEXT_PUBLIC_APP_URL is not http://127.0.0.1:3000 — auth redirects and cookies expect that exact host"
else
  warn ".env.local missing — copy .env.example, then run: npm run env:local"
fi

echo
if [ "$blocking" -eq 0 ]; then
  echo "Ready. Next: npm run supabase:start && npm run env:local && bash scripts/bootstrap-local-db.sh && npm run dev"
else
  echo "Blocked: fix the FAIL lines above. Without a container runtime AND registry egress, a local"
  echo "Supabase stack cannot run on this machine; run these steps on a machine that has Docker instead"
  echo "(see LOCAL_SETUP.md, section 3). The demo sandbox (npm run sandbox) needs neither."
  exit 1
fi
