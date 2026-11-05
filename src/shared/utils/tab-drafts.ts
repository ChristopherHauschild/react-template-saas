/**
 * Unsent form drafts kept in the browser TAB (`sessionStorage`), so that what
 * a user typed survives anything that takes the page away before it is sent:
 * a redirect to the login page when their session expires, a reload, an
 * accidental navigation. Restored when they come back to the form in the
 * same tab.
 *
 * Privacy rules, because drafts hold whatever the user wrote:
 * - per tab: `sessionStorage` is never shared with other tabs and is emptied
 *   when the tab closes;
 * - per user: every draft is keyed by its owner's user id, and forms discard
 *   other users' drafts instead of showing them (someone else may sign in in
 *   the same tab);
 * - short-lived: a form removes its draft once sent, and signing out removes
 *   every draft (`clearAllTabDrafts`).
 *
 * Storage can be unavailable (disabled, private modes, quota): every function
 * degrades to "no draft" rather than throwing — a draft is a convenience and
 * must never break the form it belongs to.
 */

const PREFIX = "draft:";

const keyFor = (form: string, ownerId: string) => `${PREFIX}${form}:${ownerId}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Accessing `sessionStorage` itself throws when storage is blocked.
    return null;
  }
}

function keys(store: Storage): string[] {
  const all: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key !== null) all.push(key);
  }
  return all;
}

/** The stored draft of `form` for `ownerId`, parsed; `null` when there is none or it is unreadable. */
export function readTabDraft(form: string, ownerId: string): unknown {
  try {
    const raw = storage()?.getItem(keyFor(form, ownerId));
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Stores `value` as the draft of `form` for `ownerId`; `null` removes it. */
export function writeTabDraft(form: string, ownerId: string, value: unknown): void {
  try {
    const store = storage();
    if (!store) return;

    if (value === null) {
      store.removeItem(keyFor(form, ownerId));
    } else {
      store.setItem(keyFor(form, ownerId), JSON.stringify(value));
    }
  } catch {
    // Quota exceeded or storage blocked: the draft simply is not kept.
  }
}

/** Removes drafts of `form` that belong to anyone but `ownerId`. */
export function discardOtherOwnersDrafts(form: string, ownerId: string): void {
  try {
    const store = storage();
    if (!store) return;

    const prefix = `${PREFIX}${form}:`;
    const mine = keyFor(form, ownerId);

    for (const key of keys(store)) {
      if (key.startsWith(prefix) && key !== mine) store.removeItem(key);
    }
  } catch {
    // Nothing to do: unreadable storage holds nothing we could show.
  }
}

/** Removes every draft of every form (on sign-out). */
export function clearAllTabDrafts(): void {
  try {
    const store = storage();
    if (!store) return;

    for (const key of keys(store)) {
      if (key.startsWith(PREFIX)) store.removeItem(key);
    }
  } catch {
    // As above.
  }
}
