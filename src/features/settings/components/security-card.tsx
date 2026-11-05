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

import {
  signOutOtherSessions,
  type SignOutOtherSessionsResult,
} from "../actions/sign-out-other-sessions";
import type { AccountSecurity } from "../services/account-security";
import { formatUtc, tokenExpiryCaveat } from "../services/format";

export const SIGN_OUT_OTHERS_LABEL = "Sign out other sessions";
export const SIGN_OUT_OTHERS_PENDING_LABEL = "Signing out other sessions…";

type Props = {
  security: AccountSecurity;
  /** Lifetime of this project's access tokens; null when unknown. */
  accessTokenLifetimeSeconds: number | null;
};

/**
 * The settings page's security card: a review of the account's sign-in facts
 * and a way to end every other session.
 *
 * What "sign out other sessions" does is stated exactly (see
 * infrastructure/auth/session/session-tokens.ts): other devices can no longer
 * use this app or renew their sign-in, but an access token they already hold
 * stays valid for direct backend calls until it expires. The copy never claims
 * a number of devices — Supabase does not report one.
 */
export function SecurityCard({ security, accessTokenLifetimeSeconds }: Props) {
  const id = useId();
  const explainId = `${id}-explain`;

  const [state, formAction, pending] = useActionState<
    SignOutOtherSessionsResult,
    FormData
  >(signOutOtherSessions, null);

  const caveat = tokenExpiryCaveat(accessTokenLifetimeSeconds);
  const facts: Array<[string, string]> = [
    ["Sign-in email", security.email ?? "None"],
    [
      "Email confirmed",
      security.emailConfirmedAt
        ? (formatUtc(security.emailConfirmedAt) ?? "Yes")
        : "Not confirmed",
    ],
    [
      "Sign-in methods",
      security.signInMethods.length > 0 ? security.signInMethods.join(", ") : "Unknown",
    ],
    ["Last sign-in", formatUtc(security.lastSignInAt) ?? "Unknown"],
    ["Account created", formatUtc(security.createdAt) ?? "Unknown"],
    [
      "Pending email change",
      security.pendingEmail
        ? `To ${security.pendingEmail} (awaiting confirmation)`
        : "None",
    ],
  ];

  return (
    <Card data-settings-section="security">
      <CardHeader>
        <CardTitle asChild>
          <h3>Security</h3>
        </CardTitle>
        <CardDescription>
          Review how this account signs in, and end other sessions.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
          {facts.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="break-all font-medium sm:break-normal sm:[overflow-wrap:anywhere]">
                {value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="space-y-2 text-sm">
          <h4 className="font-medium">Other sessions</h4>
          <p id={explainId} className="text-muted-foreground">
            Ends every other browser and device signed in to this account; this one stays
            signed in. They lose access to this app on their next request and can&apos;t
            renew their sign-in. {caveat} Changing your password does this too.
          </p>
        </div>
      </CardContent>

      <form action={formAction} aria-busy={pending} aria-label="Other sessions">
        <CardFooter className="flex-col items-start gap-3">
          <Button
            type="submit"
            variant="outline"
            disabled={pending}
            aria-busy={pending}
            aria-describedby={explainId}
          >
            {pending ? SIGN_OUT_OTHERS_PENDING_LABEL : SIGN_OUT_OTHERS_LABEL}
          </Button>

          {state?.status === "signed_out" && (
            <p role="status" className="text-sm text-muted-foreground">
              Other sessions were signed out
              {formatUtc(state.at) ? ` (${formatUtc(state.at)})` : ""}. They can no longer
              use this app or renew their sign-in.
            </p>
          )}

          {state?.status === "error" && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
