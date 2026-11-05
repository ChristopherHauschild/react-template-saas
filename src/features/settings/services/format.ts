/** Deterministic on server and client (fixed locale and zone): no hydration mismatch. */
const UTC_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const UTC_DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const UTC_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeStyle: "short",
  timeZone: "UTC",
});

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;

  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? null : date;
}

/** "1 Mar 2026, 10:00 UTC", or null for a missing or unparsable timestamp. */
export function formatUtc(iso: string | null | undefined): string | null {
  const date = parse(iso);

  return date ? `${UTC_FORMAT.format(date)} UTC` : null;
}

/** "1 Mar 2026" (the UTC calendar day), or null for a missing or unparsable timestamp. */
export function formatUtcDay(iso: string | null | undefined): string | null {
  const date = parse(iso);

  return date ? UTC_DAY_FORMAT.format(date) : null;
}

/** "10:00 UTC", or null for a missing or unparsable timestamp. */
export function formatUtcTime(iso: string | null | undefined): string | null {
  const date = parse(iso);

  return date ? `${UTC_TIME_FORMAT.format(date)} UTC` : null;
}

/** The UTC calendar day as "YYYY-MM-DD", for grouping; null if unparsable. */
export function utcDayKey(iso: string | null | undefined): string | null {
  const date = parse(iso);

  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * A token lifetime in words: "60 minutes", "2 hours", "45 seconds". Null when
 * unknown — callers then say "until it expires" without a number.
 */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 120) return `${Math.ceil(seconds)} seconds`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 120 || minutes % 60 !== 0) return `${minutes} minutes`;

  return `${minutes / 60} hours`;
}

/**
 * The one sentence every "signed out" message carries, so the UI never implies
 * more than revocation does (see infrastructure/auth/session/session-tokens.ts).
 */
export function tokenExpiryCaveat(lifetimeSeconds: number | null): string {
  const lifetime = formatDuration(lifetimeSeconds);

  return lifetime
    ? `A sign-in token a device already received can still be used directly with our backend until it expires — at most ${lifetime} after it was issued.`
    : "A sign-in token a device already received can still be used directly with our backend until it expires.";
}
