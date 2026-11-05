"use client";

import { useActionState, useId } from "react";

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

import { changeEmail, type ChangeEmailActionResult } from "../actions/change-email";
import { formatUtc } from "../services/format";
import type { Profile } from "../services/profile";

export const CHANGE_EMAIL_LABEL = "Send confirmation link";
export const CHANGE_EMAIL_PENDING_LABEL = "Sending…";
export const RESEND_EMAIL_CHANGE_LABEL = "Resend confirmation link";

type Props = {
  /** Current address and any pending change, derived server-side from the signed-in user. */
  profile: Pick<Profile, "email" | "pendingEmail" | "pendingEmailSentAt">;
};

/**
 * The settings page's email card: the current address, the state of a pending
 * change, and a form to request one.
 *
 * An email change is never immediate: Supabase emails a confirmation link to the
 * new address (and, when the project requires it, to the current one as well),
 * and the address changes only when the link(s) are opened — that is reported by
 * `/auth/callback` through the banner above the cards. So this card shows a
 * requested change as *pending*, names the address the account still uses, and
 * never says "changed".
 */
export function ChangeEmailForm({ profile }: Props) {
  const id = useId();
  const emailId = `${id}-email`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const [state, formAction, pending] = useActionState<ChangeEmailActionResult, FormData>(
    changeEmail,
    null,
  );

  const failure = state?.status === "error" ? state : null;
  const justSent = state?.status === "confirmation_sent" ? state.email : null;

  // What is pending. The server's record is the truth: after the re-render that
  // follows an accepted request it names the address just submitted, and it is
  // what a later visit shows. The address from this tab's own result is only a
  // fallback for the instant before that re-render lands — and never when the
  // server shows it as the CURRENT address (the change completed meanwhile, in
  // another tab or device): then nothing is pending.
  const sameAddress = (a: string | null, b: string | null) =>
    a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
  const pendingEmail =
    profile.pendingEmail ??
    (justSent !== null && !sameAddress(justSent, profile.email) ? justSent : null);
  const showJustSent = justSent !== null && sameAddress(justSent, pendingEmail);
  const sentAt =
    !showJustSent && profile.pendingEmailSentAt
      ? formatUtc(profile.pendingEmailSentAt)
      : null;

  return (
    <Card data-settings-section="email">
      <CardHeader>
        <CardTitle asChild>
          <h3>Email</h3>
        </CardTitle>
        <CardDescription>The address you sign in with.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <dl className="space-y-1 text-sm">
          <dt className="text-muted-foreground">Current address</dt>
          <dd data-current-email className="break-all font-medium">
            {profile.email ?? "No email on this account"}
          </dd>
        </dl>

        {pendingEmail && (
          <div
            role="status"
            data-pending-email={pendingEmail}
            className="space-y-3 rounded-xl border border-border bg-muted px-4 py-3 text-sm"
          >
            <p className="font-medium">
              {showJustSent ? "Confirmation email sent" : "Change pending confirmation"}
            </p>
            <p>
              A confirmation link {showJustSent ? "has been sent" : "was sent"} to{" "}
              <strong className="break-all">{pendingEmail}</strong>
              {sentAt ? ` (${sentAt})` : ""}. Open it to complete the change. Depending on
              your account&apos;s security settings, a link may also have gone to your
              current address — open every link you receive.
            </p>
            <p className="text-muted-foreground">
              Until then you keep signing in with{" "}
              <strong className="break-all">
                {profile.email ?? "your current address"}
              </strong>
              . Didn&apos;t get it, or the link expired? Send it again. To keep your
              current address, just ignore the emails — nothing changes until a link is
              opened.
            </p>

            {/* Its own form (same action state): a resend must not be blocked by the
                empty, required "new address" input below, nor collide with its name. */}
            <form
              action={formAction}
              aria-busy={pending}
              aria-label="Resend confirmation"
            >
              <input type="hidden" name="email" value={pendingEmail} />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={pending}
                aria-busy={pending}
              >
                {pending ? CHANGE_EMAIL_PENDING_LABEL : RESEND_EMAIL_CHANGE_LABEL}
              </Button>
            </form>
          </div>
        )}
      </CardContent>

      <form
        action={formAction}
        aria-busy={pending}
        aria-label="Email"
        className="flex flex-col gap-4"
      >
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={emailId}>
              {pendingEmail ? "Use a different address instead" : "New email address"}
            </Label>
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              placeholder="new@company.com"
              required
              // React resets the form when the action settles; keep what was typed
              // after a failure, clear it once a confirmation went out.
              defaultValue={failure?.email ?? ""}
              aria-invalid={failure?.field === "email" ? true : undefined}
              aria-describedby={
                failure?.field === "email" ? `${hintId} ${errorId}` : hintId
              }
            />
            <p id={hintId} className="text-xs text-muted-foreground">
              We&apos;ll email a confirmation link to the new address. Your email only
              changes once it has been confirmed.
            </p>
          </div>

          {failure && (
            <p
              id={errorId}
              role="alert"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {failure.error}
            </p>
          )}
        </CardContent>

        <CardFooter>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? CHANGE_EMAIL_PENDING_LABEL : CHANGE_EMAIL_LABEL}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
