"use client";

import { useActionState, useId, useState } from "react";
import Link from "next/link";

import { ROUTES } from "@/config/routes";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";

import { signUp, type SignUpActionResult, type SignUpField } from "../actions/sign-up";

import { ResendConfirmationForm } from "./resend-confirmation-form";

const LOGIN_LINK_CLASS =
  "font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline";

/**
 * `useActionState` has no reset: once the action has answered
 * `confirmation_required`, the result stays for the component's lifetime — and
 * a `<Link>` back to `/signup` is a soft navigation to the page the user is
 * already on, which keeps client state. "Use a different email" therefore
 * remounts the form (new `key`), which discards the result and every field.
 */
export function SignUpForm() {
  const [attempt, setAttempt] = useState(0);

  return <SignUpAttempt key={attempt} onRestart={() => setAttempt((n) => n + 1)} />;
}

function SignUpAttempt({ onRestart }: { onRestart: () => void }) {
  const id = useId();
  const emailId = `${id}-email`;
  const passwordId = `${id}-password`;
  const confirmPasswordId = `${id}-confirm-password`;
  const errorId = `${id}-error`;

  // Failures come back as `state.error` (+ which field, when known) and are shown
  // inline; a confirmation email sent, or the address already being registered —
  // deliberately indistinguishable, see the action — renders the panel below
  // instead of the form; success redirects.
  const [state, formAction, pending] = useActionState<SignUpActionResult, FormData>(
    signUp,
    null,
  );

  if (state?.status === "confirmation_required") {
    return (
      <Card className="w-full max-w-md border-border/60 bg-card/80 backdrop-blur shadow-xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl">Check your email</CardTitle>
          <CardDescription>
            If <strong>{state.email}</strong> can be used to sign up, a confirmation link
            may arrive there within a few minutes. Open it to finish setting up your
            account.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>Didn&apos;t get it? Check your spam folder, give it a minute, or:</p>

          <ResendConfirmationForm email={state.email} />

          <p>
            Wrong address?{" "}
            <button type="button" onClick={onRestart} className={LOGIN_LINK_CLASS}>
              Use a different email
            </button>
            .
          </p>

          <p>
            Already confirmed?{" "}
            <Link href={ROUTES.login} className={LOGIN_LINK_CLASS}>
              Sign in
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  const fieldError = state?.status === "error" ? state : null;
  const describedBy = (field: SignUpField) =>
    fieldError?.field === field ? errorId : undefined;
  const invalid = (field: SignUpField) =>
    fieldError?.field === field ? true : undefined;

  return (
    <Card className="w-full max-w-md border-border/60 bg-card/80 backdrop-blur shadow-xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Create your account</CardTitle>
        <CardDescription>Start in less than a minute</CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="space-y-5" aria-busy={pending}>
          <div className="space-y-2">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              placeholder="john@company.com"
              required
              // React resets the form when the action settles; the echoed email
              // becomes the new default so a failed attempt keeps it in place.
              defaultValue={fieldError?.email ?? ""}
              aria-invalid={invalid("email")}
              aria-describedby={describedBy("email")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={passwordId}>Password</Label>
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              required
              minLength={8}
              aria-invalid={invalid("password")}
              aria-describedby={describedBy("password")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={confirmPasswordId}>Confirm password</Label>
            <Input
              id={confirmPasswordId}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              required
              minLength={8}
              aria-invalid={invalid("confirmPassword")}
              aria-describedby={describedBy("confirmPassword")}
            />
          </div>

          {fieldError && (
            <p
              id={errorId}
              role="alert"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {fieldError.error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href={ROUTES.login} className={LOGIN_LINK_CLASS}>
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
