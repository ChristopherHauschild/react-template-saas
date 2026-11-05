// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  isServerActionRequest,
  isSessionRemoval,
  keepDeadSessionCookies,
} from "./action-session-cookies";

const cleared = (name: string) => ({ name, value: "" });
const written = (name: string) => ({ name, value: "base64-eyJ…" });

describe("action-session-cookies", () => {
  it("recognises a Server Action request by Next's header", () => {
    expect(isServerActionRequest(new Headers({ "next-action": "7f3a" }))).toBe(true);
    expect(isServerActionRequest(new Headers({ "Next-Action": "7f3a" }))).toBe(true);
    expect(isServerActionRequest(new Headers())).toBe(false);
  });

  it("a batch that only clears cookies is a session removal", () => {
    expect(isSessionRemoval([cleared("sb-auth-token")])).toBe(true);
    expect(
      isSessionRemoval([cleared("sb-auth-token.0"), cleared("sb-auth-token.1")]),
    ).toBe(true);
  });

  it("a session save is not a removal, even when it clears stale chunks", () => {
    // @supabase/ssr writes the new chunks and clears leftover ones in ONE batch;
    // skipping the clearing would leave a stale chunk that corrupts the session.
    expect(
      isSessionRemoval([cleared("sb-auth-token.1"), written("sb-auth-token.0")]),
    ).toBe(false);
    expect(isSessionRemoval([written("sb-auth-token")])).toBe(false);
  });

  it("an empty batch is not a removal", () => {
    expect(isSessionRemoval([])).toBe(false);
  });

  it("keeps dead-session cookies only for a removal during an action", () => {
    expect(keepDeadSessionCookies(true, [cleared("a")])).toBe(true);
    expect(keepDeadSessionCookies(false, [cleared("a")])).toBe(false);
    expect(keepDeadSessionCookies(true, [cleared("a.1"), written("a.0")])).toBe(false);
  });
});
