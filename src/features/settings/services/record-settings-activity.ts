import "server-only";

import type { AccountActivityEvent } from "@/infrastructure/account-activity/events";
import { recordAccountActivity } from "@/infrastructure/account-activity/record-account-activity";

/**
 * Records an event for a settings change that has ALREADY succeeded.
 *
 * Two rules every settings action follows, and this helper exists to make the
 * second one unconditional:
 *
 * 1. Record only after the change is confirmed — never before, never on a
 *    failure — so the history holds nothing that did not happen. That is the
 *    caller's job (call this at the point of success).
 * 2. Recording is a side effect; the change stands whatever happens here. The
 *    writer reports failures as a value and never throws by contract, and this
 *    wrapper holds even if that contract were broken: a throw is logged (class
 *    name only — the event's details may hold profile data) and swallowed.
 *
 * `userId` must be the id of the user the request was verified for
 * (`requireAuth()`), never anything taken from input.
 */
export async function recordSettingsActivity(
  userId: string,
  event: AccountActivityEvent,
): Promise<void> {
  try {
    // The writer logs its own failures (with the database's reason).
    await recordAccountActivity(userId, event);
  } catch (thrown) {
    console.error("[settings] activity recording threw; the change itself stands", {
      type: event.type,
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
  }
}
