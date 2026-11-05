#!/usr/bin/env python3
"""Populate local development Supabase values from `supabase status -o env`.

Never uploads, prints, or records credentials. Existing Stripe configuration is kept.
A started local stack is a prerequisite. The Supabase CLI is taken from PATH or,
failing that, from the project's devDependencies (`node_modules/.bin/supabase`,
i.e. what `npx supabase` runs).
"""
from __future__ import annotations

from pathlib import Path
import os
import re
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / '.env.local'
TEMPLATE = ROOT / '.env.example'


def find_cli() -> str | None:
    local = ROOT / 'node_modules' / '.bin' / ('supabase.cmd' if os.name == 'nt' else 'supabase')
    if local.exists():
        return str(local)
    return shutil.which('supabase')


cli = find_cli()
if cli is None:
    print('Supabase CLI not found. Run `npm ci` (it is a devDependency, used via `npx supabase`) '
          'or install it globally, then rerun this script.', file=sys.stderr)
    sys.exit(1)

try:
    result = subprocess.run([cli, 'status', '-o', 'env'], cwd=ROOT,
                            capture_output=True, text=True, check=True)
except subprocess.CalledProcessError as exc:
    # The CLI's last line is a generic "--debug" hint; the cause is the first one.
    detail = [l for l in (exc.stderr or '').strip().splitlines() if l.strip()]
    print('The local Supabase stack is not running (or Docker is unavailable).\n'
          'Run `npm run supabase:start` (needs Docker or Podman), then rerun this script.'
          + (f"\nCLI said: {detail[0]}" if detail else ''), file=sys.stderr)
    sys.exit(1)

values: dict[str, str] = {}
for line in result.stdout.splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    if not re.fullmatch(r'[A-Z][A-Z0-9_]*', k):
        continue
    try:
        split = shlex.split(v, comments=False)
        values[k] = split[0] if split else ''
    except ValueError:
        values[k] = v.strip('"\'')

mapping = {
    'NEXT_PUBLIC_SUPABASE_URL': values.get('API_URL'),
    'NEXT_PUBLIC_SUPABASE_ANON_KEY': values.get('ANON_KEY') or values.get('PUBLISHABLE_KEY'),
    'SUPABASE_SERVICE_ROLE_KEY': values.get('SERVICE_ROLE_KEY') or values.get('SECRET_KEY'),
}
if any(not v for v in mapping.values()):
    print('Supabase CLI did not return API_URL, ANON_KEY or SERVICE_ROLE_KEY. '
          'Verify `supabase status -o env` and configure .env.local manually.', file=sys.stderr)
    sys.exit(1)

source = DEST.read_text() if DEST.exists() else TEMPLATE.read_text()
for key, value in mapping.items():
    # Preserve existing comments and unrelated variables, including Stripe test settings.
    escaped = value.replace('\\', '\\\\')
    pattern = re.compile(rf'^{re.escape(key)}=.*$', re.MULTILINE)
    line = f'{key}={escaped}'
    source = pattern.sub(lambda _: line, source) if pattern.search(source) else source + f'\n{line}\n'

DEST.write_text(source)
os.chmod(DEST, 0o600)
print('Updated .env.local with local Supabase API URL and keys. '
      'Set your own Stripe test credentials if you need checkout or the Customer Portal.')
