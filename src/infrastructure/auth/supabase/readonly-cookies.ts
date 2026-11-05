/**
 * Recognises the error Next.js throws when `cookies().set()` / `.delete()` is
 * called while cookies are read-only — i.e. during Server Component rendering
 * (only Server Actions and Route Handlers may mutate cookies).
 *
 * Next does not export the error class from a public entry point and its `name`
 * is a plain "Error", so the message is the only stable signal. It has been
 * "Cookies can only be modified in a Server Action or Route Handler. …" since
 * Next 13.4. If Next ever rewords it, this returns false and the error
 * propagates — failing loudly rather than silently swallowing something new.
 */
export function isReadonlyCookiesError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(
      "Cookies can only be modified in a Server Action or Route Handler",
    )
  );
}
