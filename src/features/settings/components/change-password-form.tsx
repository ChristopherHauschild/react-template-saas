"use client";

import { useActionState, useId } from "react";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/config/passwordPolicy";
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

import {
  changePassword,
  type ChangePasswordActionResult,
  type ChangePasswordField,
} from "../actions/change-password";
import { tokenExpiryCaveat } from "../services/format";

export const CHANGE_PASSWORD_LABEL = "Change password";
export const CHANGE_PASSWORD_PENDING_LABEL = "Changing password…";
export const PASSWORD_CHANGED_MESSAGE =
  "Your password has been changed. Use it the next time you sign in.";
/**
 * Deliberately precise: revocation ends other sessions for THIS APP at once, but
 * cannot revoke access tokens already issued (see tokenExpiryCaveat). The
 * earlier wording ("have been signed out") implied more than that.
 */
export const OTHER_SESSIONS_SIGNED_OUT_MESSAGE =
  "Other browsers and devices signed in to this account have been signed out: they can no longer use this app or renew their sign-in.";
export const OTHER_SESSIONS_NOT_SIGNED_OUT_MESSAGE =
  "We couldn't sign out your other sessions. Use “Sign out other sessions” in the Security section below to try again.";

type Props = {
  /**
   * The account's sign-in address, exposed to password managers as the
   * (hidden) username of this credential so they update the right entry. Not
   * part of the submission.
   */
  email: string | null;
  /** Lifetime of this project's access tokens, for the "signed out" caveat; null when unknown. */
  accessTokenLifetimeSeconds?: number | null;
};

/**
 * The settings page's password card. Asks for the current password (so an
 * unattended or hijacked session cannot lock the owner out) and the new one
 * twice.
 *
 * The fields are uncontrolled and have no default values: React resets the form
 * when the action settles, so every attempt — successful or not — leaves the
 * password fields empty, and the action never echoes what was typed.
 */
export function ChangePasswordForm({ email, accessTokenLifetimeSeconds = null }: Props) {
  const id = useId();
  const currentId = `${id}-current`;
  const newId = `${id}-new`;
  const newHintId = `${id}-new-hint`;
  const confirmId = `${id}-confirm`;
  const errorId = `${id}-error`;

  const [state, formAction, pending] = useActionState<
    ChangePasswordActionResult,
    FormData
  >(changePassword, null);

  const failure = state?.status === "error" ? state : null;
  const changed = state?.status === "changed" ? state : null;

  const invalid = (field: ChangePasswordField) =>
    failure?.field === field ? true : undefined;
  const describedBy = (field: ChangePasswordField, ...always: string[]) => {
    const ids = [...always, failure?.field === field ? errorId : null].filter(Boolean);
    return ids.length > 0 ? ids.join(" ") : undefined;
  };

  return (
    <Card data-settings-section="password">
      <CardHeader>
        <CardTitle asChild>
          <h3>Password</h3>
        </CardTitle>
        <CardDescription>Change the password you sign in with.</CardDescription>
      </CardHeader>

      <form
        action={formAction}
        aria-busy={pending}
        aria-label="Password"
        className="flex flex-col gap-4"
      >
        <CardContent className="space-y-5">
          {/* Password managers pair a password change with the account it belongs
              to through a username field; keep it out of sight and out of the
              submission (no `name`). */}
          {email && (
            <input
              type="text"
              autoComplete="username"
              value={email}
              readOnly
              hidden
              aria-hidden="true"
              tabIndex={-1}
            />
          )}

          <div className="space-y-2">
            <Label htmlFor={currentId}>Current password</Label>
            <Input
              id={currentId}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              required
              aria-invalid={invalid("currentPassword")}
              aria-describedby={describedBy("currentPassword")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={newId}>New password</Label>
            <Input
              id={newId}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-invalid={invalid("newPassword")}
              aria-describedby={describedBy("newPassword", newHintId)}
            />
            <p id={newHintId} className="text-xs text-muted-foreground">
              At least {PASSWORD_MIN_LENGTH} characters, and different from your current
              password.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={confirmId}>Confirm new password</Label>
            <Input
              id={confirmId}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-invalid={invalid("confirmPassword")}
              aria-describedby={describedBy("confirmPassword")}
            />
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

          {changed && (
            <div role="status" className="space-y-1 text-sm text-muted-foreground">
              <p>{PASSWORD_CHANGED_MESSAGE}</p>
              {changed.otherSessionsSignedOut ? (
                <p>
                  {OTHER_SESSIONS_SIGNED_OUT_MESSAGE}{" "}
                  {tokenExpiryCaveat(accessTokenLifetimeSeconds)}
                </p>
              ) : (
                <p>{OTHER_SESSIONS_NOT_SIGNED_OUT_MESSAGE}</p>
              )}
            </div>
          )}
        </CardContent>

        <CardFooter>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? CHANGE_PASSWORD_PENDING_LABEL : CHANGE_PASSWORD_LABEL}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
