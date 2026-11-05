#!/usr/bin/env bash
# Runs a command with TEST_DATABASE_URL pointing at a throwaway local PostgreSQL
# cluster, then tears the cluster down. Used by `npm run test:db`.
#
# Requires PostgreSQL server binaries (initdb, pg_ctl) on PATH — e.g.
#   Debian/Ubuntu: apt install postgresql        macOS: brew install postgresql@16
# Alternatively, skip this script and point TEST_DATABASE_URL at a running
# database yourself, e.g. the one from `supabase start`:
#   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run integration
#
# If TEST_DATABASE_URL is already set, the command runs against it unchanged.
#
# Running as root (a Docker container, a CI job, sudo): PostgreSQL refuses to
# run as root — initdb, pg_ctl and the server all check, and there is no
# override. The server commands then run as an unprivileged account instead:
# WITH_LOCAL_POSTGRES_USER if set, else the user behind sudo ($SUDO_USER), else
# the `postgres` system account PostgreSQL packages create, else `nobody`. The
# command itself (the tests) still runs as root and connects over the unix
# socket, which root may always open.
set -euo pipefail

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  exec "$@"
fi

for bin in initdb pg_ctl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    # Debian/Ubuntu install binaries outside PATH; pick the newest version.
    candidate=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
    if [[ -n "$candidate" && -x "$candidate/$bin" ]]; then
      export PATH="$candidate:$PATH"
    else
      echo "error: '$bin' not found. Install PostgreSQL server binaries or set TEST_DATABASE_URL." >&2
      exit 1
    fi
  fi
done

# Absolute paths: the account the server runs as may not share this PATH.
INITDB=$(command -v initdb)
PG_CTL=$(command -v pg_ctl)

# `as_server_user cmd args…` runs a PostgreSQL server command: directly, or —
# when this script runs as root — as an unprivileged account.
SERVER_USER=""
if [[ "$(id -u)" -eq 0 ]]; then
  SERVER_USER="${WITH_LOCAL_POSTGRES_USER:-}"
  if [[ -z "$SERVER_USER" && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    SERVER_USER="$SUDO_USER"
  fi
  if [[ -z "$SERVER_USER" ]]; then
    if id -u postgres >/dev/null 2>&1; then SERVER_USER=postgres; else SERVER_USER=nobody; fi
  fi
  if [[ "$(id -u "$SERVER_USER" 2>/dev/null || echo 0)" -eq 0 ]]; then
    echo "error: running as root, and '$SERVER_USER' is not an unprivileged account for PostgreSQL." >&2
    echo "       Set WITH_LOCAL_POSTGRES_USER to a non-root user." >&2
    exit 1
  fi
  if ! command -v runuser >/dev/null 2>&1 && ! command -v su >/dev/null 2>&1; then
    echo "error: running as root, but neither 'runuser' nor 'su' is available to start PostgreSQL as '$SERVER_USER'." >&2
    exit 1
  fi
fi

as_server_user() {
  if [[ -z "$SERVER_USER" ]]; then
    "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVER_USER" -- "$@"
  else
    su -s /bin/sh "$SERVER_USER" -c "$(printf '%q ' "$@")"
  fi
}

# Under /tmp when switching accounts: root's TMPDIR may not be reachable by it.
if [[ -n "$SERVER_USER" ]]; then
  PGDIR=$(mktemp -d /tmp/pgtest.XXXXXX)
else
  PGDIR=$(mktemp -d -t pgtest.XXXXXX)
fi
PORT=${PGPORT_TEST:-55432}

# Installed before anything else can fail, so no run leaves a directory behind.
cleanup() {
  as_server_user "$PG_CTL" -D "$PGDIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$PGDIR"
}
trap cleanup EXIT

if [[ -n "$SERVER_USER" ]]; then
  chown "$SERVER_USER" "$PGDIR"
fi

as_server_user "$INITDB" -D "$PGDIR" -U postgres --auth=trust >/dev/null
as_server_user "$PG_CTL" -D "$PGDIR" -o "-p $PORT -k $PGDIR -c listen_addresses=''" \
  -l "$PGDIR/postgres.log" -w start >/dev/null

export TEST_DATABASE_URL="postgresql://postgres@localhost:$PORT/postgres?host=$PGDIR"

echo "[with-local-postgres] PostgreSQL $("$PG_CTL" --version | awk '{print $3}') on unix socket $PGDIR (port $PORT)${SERVER_USER:+, server running as '$SERVER_USER'}"
"$@"
