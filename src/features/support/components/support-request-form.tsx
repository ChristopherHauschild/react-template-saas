"use client";

import {
  type FormEvent,
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ROUTES } from "@/config/routes";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Textarea } from "@/shared/components/ui/textarea";
import { cn } from "@/shared/utils/cn";
import {
  discardOtherOwnersDrafts,
  readTabDraft,
  writeTabDraft,
} from "@/shared/utils/tab-drafts";

import {
  createSupportRequestAction,
  type CreateSupportRequestActionResult,
} from "../actions/create-support-request";
import type { SupportRequestField } from "../services/create-support-request";
import {
  PAGE_OWNER_FIELD,
  SUPPORT_REQUEST_CATEGORIES,
  SUPPORT_REQUEST_MESSAGE_MAX_LENGTH,
  SUPPORT_REQUEST_SUBJECT_MAX_LENGTH,
  type SupportRequestCategory,
} from "../services/support-request";
import {
  SUPPORT_REQUEST_CATEGORY_LABELS,
  SUPPORT_REQUEST_FORM_COPY as COPY,
  supportRequestSentMessage,
} from "../services/support-request-copy";

/** Name of this form's drafts in the tab's storage (see `@/shared/utils/tab-drafts`). */
export const SUPPORT_REQUEST_DRAFT = "support-request";

type Draft = { category: string; subject: string; message: string };

const isBlankDraft = (draft: Draft) =>
  draft.category === "" && draft.subject.trim() === "" && draft.message.trim() === "";

/** The form's current values, as a draft. */
function draftOf(form: HTMLFormElement): Draft {
  const data = new FormData(form);
  const text = (name: string) => {
    const value = data.get(name);
    return typeof value === "string" ? value : "";
  };

  return {
    category: text("category"),
    subject: text("subject"),
    message: text("message"),
  };
}

/**
 * A stored draft, if it has the shape this form writes. Storage is the
 * browser's and could hold anything; a draft that does not fit is ignored.
 */
function parseDraft(value: unknown): Draft | null {
  if (value === null || typeof value !== "object") return null;

  const { category, subject, message } = value as Record<string, unknown>;

  if (
    typeof category !== "string" ||
    typeof subject !== "string" ||
    typeof message !== "string" ||
    (category !== "" &&
      !SUPPORT_REQUEST_CATEGORIES.includes(category as SupportRequestCategory)) ||
    [...subject].length > SUPPORT_REQUEST_SUBJECT_MAX_LENGTH ||
    [...message].length > SUPPORT_REQUEST_MESSAGE_MAX_LENGTH
  ) {
    return null;
  }

  return { category, subject, message };
}

/** Puts `draft` into the form's fields (uncontrolled inputs: set the DOM directly). */
function applyDraft(form: HTMLFormElement, draft: Draft) {
  const field = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;

  const subject = field("subject");
  const message = field("message");
  if (subject) subject.value = draft.subject;
  if (message) message.value = draft.message;

  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="category"]')) {
    radio.checked = radio.value === draft.category;
  }
}

/** `false` during server rendering and hydration, `true` once React runs in the browser. */
const subscribeNever = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

/**
 * The support page's form: a category, a one-line subject and a message.
 *
 * Keeping what the user typed. A form whose `action` prop is a function is
 * RESET by React once the action settles — a plain `form.reset()` — which
 * would wipe the draft after every failure. The usual remedy (re-render each
 * field's default from values the action echoes back) does not hold for the
 * category radios: after a change React re-applies `defaultChecked` to every
 * radio of the group, re-checking the previous answer over the user's new
 * choice, and controlled radios are reset to their mount-time state instead.
 * So this form opts out of the reset altogether: it submits from `onSubmit`
 * inside a transition, which React does not follow with a reset. On failure
 * the fields simply keep exactly what was entered; on success the form is
 * reset explicitly for the next request. (Tests pin both halves, and the
 * radio regression.) While the action runs the fields are disabled: a success
 * resets the form, which would throw away anything typed meanwhile.
 *
 * The submit button stays disabled until hydration: before that, a click
 * would be a native submission, which this form has no endpoint for.
 *
 * Surviving navigation. Nothing on the support page navigates away on its
 * own — an ended session is reported in place, never by redirecting — but
 * some navigations cannot be ruled out from here (a route re-render whose
 * guard finds the session gone, a reload, a slip of the back button). So the
 * draft is also kept in the TAB's storage while it is being written, keyed by
 * the signed-in user (`ownerId`), and put back when the form is opened
 * again in that tab by the same user, with a note saying so and a way to
 * discard it. It is removed once sent, when discarded or emptied, and on
 * sign-out; drafts of other users are discarded, never shown. A restored
 * draft never overwrites anything already typed.
 *
 * One account per form. If the session changes hands while the page is open
 * (someone signs in as another user, e.g. in another tab — tabs share
 * cookies), sending is refused (`accountChanged`) and the text stays here for
 * its author; nothing typed for one account is filed under another.
 *
 * Errors. A field error is shown under its field, wired to it with
 * `aria-invalid`/`aria-describedby`, and focus moves to that field. Other
 * failures (flood limit, outage, expired session) are shown above the submit
 * button without flagging any input. An expired session offers to sign in in
 * a new tab, so the draft stays here and can simply be sent again afterwards.
 *
 * The browser's own checks (`required`, `maxLength`) run first and are never
 * looser than the server's: `maxLength` counts UTF-16 units, the server counts
 * characters, so the browser can only be stricter. What they cannot see
 * (a subject of spaces, control characters) the server reports per field.
 */
type Props = {
  /**
   * The account this page belongs to (the user it was rendered for).
   * - Drafts kept in the tab are this account's alone, so someone else
   *   signing in in the same tab never sees them.
   * - Every submission carries it, and the server refuses to send if the
   *   session now belongs to another account — a request typed for one
   *   account is never filed under another.
   * The page keys this form by it: a re-render for a different account mounts
   * a fresh, empty form rather than handing this one's text to the new owner.
   */
  ownerId: string;
};

export function SupportRequestForm({ ownerId }: Props) {
  const id = useId();
  const fieldId = (field: SupportRequestField) => `${id}-${field}`;
  const errorId = (field: SupportRequestField) => `${id}-${field}-error`;
  const legendId = `${id}-category-legend`;
  const messageHintId = `${id}-message-hint`;
  const formErrorId = `${id}-form-error`;

  const [state, formAction, pending] = useActionState<
    CreateSupportRequestActionResult,
    FormData
  >(createSupportRequestAction, null);

  const failure = state?.status === "error" ? state : null;
  const sent = state?.status === "sent" ? state : null;
  const invalidField = failure?.field ?? null;
  const hydrated = useHydrated();
  const [restored, setRestored] = useState(false);
  const restoredNoticeId = `${id}-restored`;

  const formRef = useRef<HTMLFormElement>(null);
  const categoryGroup = useRef<HTMLFieldSetElement>(null);
  const subject = useRef<HTMLInputElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);

  // Put back a draft this user left in this tab (e.g. before being sent to
  // the login page), unless something has been typed already.
  useEffect(() => {
    discardOtherOwnersDrafts(SUPPORT_REQUEST_DRAFT, ownerId);

    const form = formRef.current;
    const draft = parseDraft(readTabDraft(SUPPORT_REQUEST_DRAFT, ownerId));

    if (!form || !draft || isBlankDraft(draft) || !isBlankDraft(draftOf(form))) return;

    applyDraft(form, draft);
    // The DOM was just changed outside React; say so on screen.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRestored(true);
  }, [ownerId]);

  // Keep the draft current as the user types (and forget it once emptied).
  //
  // NATIVE listeners, not React's `onChange`: React drops a change whose
  // value equals the one it last tracked, and the native `reset()` after a
  // send leaves it tracking the text that was just sent — so re-picking the
  // same category or pasting the same text again fired no `onChange`, and the
  // draft silently missed it (found in Chromium). Every native input/change
  // event is handled; the draft is read from the whole form each time.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    const saveDraft = () => {
      const draft = draftOf(form);
      writeTabDraft(SUPPORT_REQUEST_DRAFT, ownerId, isBlankDraft(draft) ? null : draft);
    };

    form.addEventListener("input", saveDraft);
    form.addEventListener("change", saveDraft);
    return () => {
      form.removeEventListener("input", saveDraft);
      form.removeEventListener("change", saveDraft);
    };
  }, [ownerId]);

  const discardDraft = () => {
    formRef.current?.reset();
    writeTabDraft(SUPPORT_REQUEST_DRAFT, ownerId, null);
    setRestored(false);
    subject.current?.focus();
  };

  // Filed: start over with an empty form for the next request, and forget the
  // draft. Only here — after a failure the form (and draft) stay as they were.
  useEffect(() => {
    if (!sent) return;
    formRef.current?.reset();
    writeTabDraft(SUPPORT_REQUEST_DRAFT, ownerId, null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRestored(false);
  }, [sent, ownerId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // The browser's own checks (required, maxLength) have passed by now.
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    // Which account this request was written for; see `sessionForPage`.
    formData.set(PAGE_OWNER_FIELD, ownerId);
    startTransition(() => formAction(formData));
  };

  // Take the user to the field that needs fixing. Keyed on the result object,
  // so a second identical failure moves focus again.
  useEffect(() => {
    if (!failure?.field) return;

    if (failure.field === "category") {
      const radios =
        categoryGroup.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      const target = [...(radios ?? [])].find((radio) => radio.checked) ?? radios?.[0];
      target?.focus();
    } else {
      (failure.field === "subject" ? subject : message).current?.focus();
    }
  }, [failure]);

  const invalid = (field: SupportRequestField) =>
    invalidField === field ? true : undefined;
  const describedBy = (field: SupportRequestField, ...always: string[]) => {
    const ids = [...always, invalidField === field ? errorId(field) : null].filter(
      Boolean,
    );
    return ids.length > 0 ? ids.join(" ") : undefined;
  };

  const fieldError = (field: SupportRequestField) =>
    invalidField === field ? (
      <p
        id={errorId(field)}
        role="alert"
        className="text-sm text-red-600 dark:text-red-400"
      >
        {failure?.error}
      </p>
    ) : null;

  return (
    <Card data-support-section="new-request">
      <CardHeader>
        <CardTitle asChild>
          <h3>{COPY.title}</h3>
        </CardTitle>
        <CardDescription>{COPY.description}</CardDescription>
      </CardHeader>

      <form
        ref={formRef}
        onSubmit={submit}
        aria-busy={pending}
        aria-label={COPY.title}
        className="flex flex-col gap-4"
      >
        <CardContent>
          {/* Not beside the "sent" confirmation, even for the moment before
              the effect that forgets the draft has run. */}
          {restored && !sent && (
            <div
              id={restoredNoticeId}
              role="status"
              className="mb-5 flex flex-col gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <p>{COPY.draftRestored}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={discardDraft}
                className="shrink-0"
              >
                {COPY.discardDraft}
              </Button>
            </div>
          )}

          {/* Disabled while sending: edits made now would be lost to the reset. */}
          <fieldset disabled={pending} className="min-w-0 space-y-5">
            {/* A radio group carries the invalid state (ARIA does not support it
                on individual radios); the legend names it. */}
            <fieldset
              ref={categoryGroup}
              role="radiogroup"
              aria-labelledby={legendId}
              aria-required="true"
              aria-invalid={invalid("category")}
              aria-describedby={describedBy("category")}
              className="min-w-0 space-y-2"
            >
              <legend id={legendId} className="mb-2 text-sm leading-none font-medium">
                {COPY.categoryLegend}
              </legend>

              <div className="grid gap-2 sm:grid-cols-2">
                {SUPPORT_REQUEST_CATEGORIES.map((category) => (
                  <label
                    key={category}
                    className={cn(
                      "flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                      invalidField === "category" && "border-destructive",
                    )}
                  >
                    <input
                      type="radio"
                      name="category"
                      value={category}
                      required
                      className="size-4 shrink-0 accent-primary outline-none"
                    />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {SUPPORT_REQUEST_CATEGORY_LABELS[category]}
                    </span>
                  </label>
                ))}
              </div>

              {fieldError("category")}
            </fieldset>

            <div className="space-y-2">
              <Label htmlFor={fieldId("subject")}>{COPY.subjectLabel}</Label>
              <Input
                ref={subject}
                id={fieldId("subject")}
                name="subject"
                type="text"
                autoComplete="off"
                placeholder={COPY.subjectPlaceholder}
                required
                maxLength={SUPPORT_REQUEST_SUBJECT_MAX_LENGTH}
                aria-invalid={invalid("subject")}
                aria-describedby={describedBy("subject")}
              />
              {fieldError("subject")}
            </div>

            <div className="space-y-2">
              <Label htmlFor={fieldId("message")}>{COPY.messageLabel}</Label>
              <Textarea
                ref={message}
                id={fieldId("message")}
                name="message"
                rows={6}
                placeholder={COPY.messagePlaceholder}
                required
                maxLength={SUPPORT_REQUEST_MESSAGE_MAX_LENGTH}
                aria-invalid={invalid("message")}
                aria-describedby={describedBy("message", messageHintId)}
              />
              <p id={messageHintId} className="text-xs text-muted-foreground">
                Up to {SUPPORT_REQUEST_MESSAGE_MAX_LENGTH.toLocaleString("en-US")}{" "}
                characters.
              </p>
              {fieldError("message")}
            </div>
          </fieldset>

          {failure && !failure.field && (
            <div
              id={formErrorId}
              role="alert"
              className="mt-5 space-y-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <p>{failure.error}</p>
              {(failure.reason === "sessionExpired" ||
                failure.reason === "accountChanged") && (
                <p>
                  <a
                    href={ROUTES.login}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-4"
                  >
                    {COPY.signInAgain}
                  </a>
                </p>
              )}
            </div>
          )}

          {sent && (
            <p role="status" className="mt-5 text-sm text-muted-foreground">
              {supportRequestSentMessage(sent.request?.subject ?? null)}
            </p>
          )}
        </CardContent>

        <CardFooter>
          <Button type="submit" disabled={pending || !hydrated} aria-busy={pending}>
            {pending ? COPY.submitPending : COPY.submit}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
