/**
 * Inert stand-in for the `server-only` marker module under Vitest.
 *
 * In Next.js, `import "server-only"` is a build-time guard that fails the build when
 * a server module is pulled into a client bundle. Vitest has no such bundler
 * boundary, so `vitest.config.ts` aliases the marker here to let server modules be
 * unit tested. This does not weaken the guard in the real build.
 */
export {};
