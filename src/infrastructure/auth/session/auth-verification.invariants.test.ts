// @vitest-environment node
/**
 * The settings page tells users that a revoked session "can no longer use this
 * app" from its next request on, even while its access token is unexpired. That
 * is only true because every auth decision on the server asks GoTrue
 * (`auth.getUser()`), which rejects a deleted session (`session_not_found`).
 *
 * `auth.getSession()` and `auth.getClaims()` do not: the first trusts the cookie,
 * the second verifies the JWT locally (signature + expiry) — a revoked session's
 * token passes both until it expires. This test pins where they may appear.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((file) => ({
  file: path.relative(SRC, file),
  // Comments may talk about these calls; only code counts.
  code: readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1"),
}));

/**
 * `getSession()` is allowed ONLY to obtain the access token that is then sent to
 * GoTrue (which verifies it) or to read informational facts (its lifetime).
 */
const GET_SESSION_ALLOWED = ["infrastructure/auth/session/session-tokens.ts"];

describe("server-side auth decisions are verified by GoTrue", () => {
  it("getSession() is used nowhere except the session-token helper", () => {
    const offenders = files
      .filter(({ code }) => /\.getSession\(/.test(code))
      .map(({ file }) => file)
      .filter((file) => !GET_SESSION_ALLOWED.includes(file));

    expect(offenders).toEqual([]);
  });

  it("getClaims() (local JWT verification) is not used at all", () => {
    expect(
      files.filter(({ code }) => /\.getClaims\(/.test(code)).map((f) => f.file),
    ).toEqual([]);
  });

  it("the proxy and the session lookup behind every guard call getUser()", () => {
    const byName = Object.fromEntries(files.map((f) => [f.file, f.code]));

    expect(byName["proxy.ts"]).toMatch(/auth\.getUser\(\)/);
    expect(byName["infrastructure/auth/session/get-current-user.ts"]).toMatch(
      /auth\.getUser\(\)/,
    );
  });

  it("the session-token helper never authorizes: it does not export a user or claims", () => {
    const helper = byFile("infrastructure/auth/session/session-tokens.ts");

    expect(helper).not.toMatch(/session\.user/);
    expect(helper).not.toMatch(/getUser\(/);
  });
});

function byFile(name: string) {
  return files.find((f) => f.file === name)!.code;
}
