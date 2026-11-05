/**
 * Sentinel origin used to resolve candidate paths. Anything that resolves to a
 * different origin was not a plain path. The host is syntactically valid but not
 * routable, so a bug here could never produce a working external link.
 */
const SENTINEL_ORIGIN = "https://redirect-sentinel.invalid";

/**
 * Resolves an untrusted "where to go next" value (e.g. a `?next=` query
 * parameter) to a same-origin path, or `fallback` when it is anything else.
 *
 * The candidate is resolved by the WHATWG URL parser against a sentinel origin,
 * exactly as a browser would resolve a `Location` header. It is accepted only if
 * the result stays on that origin, which rejects every way of smuggling a host
 * in: absolute URLs (`https://evil.example`), scheme-relative (`//evil.example`),
 * backslash variants (`/\evil.example`, which browsers treat as `//`), embedded
 * tabs/newlines (which browsers strip before parsing) and non-HTTP schemes
 * (`javascript:`). What comes back is the normalised path, query and fragment —
 * never the raw input — so the caller can safely interpolate it.
 *
 * Accepts `/dashboard`, `/pricing?checkout=success`, `/docs#install`.
 * Rejects `https://evil.example`, `//evil.example`, `/\evil.example`,
 * `javascript:alert(1)`, `dashboard` (relative), `""`, `null`.
 */
export function resolveSafeRedirectPath(candidate: unknown, fallback: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return fallback;
  }

  // Only absolute paths qualify. A relative reference ("dashboard") would resolve
  // against the current URL, which is not what a `next` parameter means.
  if (!candidate.startsWith("/")) {
    return fallback;
  }

  let resolved: URL;

  try {
    resolved = new URL(candidate, SENTINEL_ORIGIN);
  } catch {
    return fallback;
  }

  if (resolved.origin !== SENTINEL_ORIGIN) {
    return fallback;
  }

  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;

  // The normalised path must itself survive the same check: dot-segment
  // resolution can manufacture a scheme-relative URL out of a same-origin input
  // (`/..//evil.example` → pathname `//evil.example`), which a browser would then
  // follow to another host.
  if (new URL(path, SENTINEL_ORIGIN).origin !== SENTINEL_ORIGIN) {
    return fallback;
  }

  return path;
}
