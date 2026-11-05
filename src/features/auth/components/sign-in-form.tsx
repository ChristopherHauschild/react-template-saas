"use client";

import { useActionState, useId } from "react";
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

import { signIn, type SignInActionResult } from "../actions/sign-in";

import { ResendConfirmationForm } from "./resend-confirmation-form";

export function SignInForm() {
  const id = useId();
  const emailId = `${id}-email`;
  const passwordId = `${id}-password`;
  const errorId = `${id}-error`;

  // Failures come back as `state.error` and are shown inline; success redirects.
  const [state, formAction, pending] = useActionState<SignInActionResult, FormData>(
    signIn,
    null,
  );

  const hasError = Boolean(state?.error);

  return (
    <Card className="w-full max-w-md border-border/60 bg-card/80 backdrop-blur shadow-xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>
          Enter your email and password to access your account
        </CardDescription>
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
              defaultValue={state?.email ?? ""}
              aria-invalid={hasError || undefined}
              aria-describedby={hasError ? errorId : undefined}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={passwordId}>Password</Label>
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              required
              aria-invalid={hasError || undefined}
              aria-describedby={hasError ? errorId : undefined}
            />
          </div>

          {state?.error && (
            <p
              id={errorId}
              role="alert"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {state.error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        {/* Outside the sign-in <form>: forms cannot nest. Uses the address the
            user just submitted; a new link does not require going back to sign-up. */}
        {state?.needsConfirmation && (
          <div className="mt-5 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3">
            <p className="text-sm text-muted-foreground">
              Lost the confirmation email for <strong>{state.email}</strong>?
            </p>
            <ResendConfirmationForm email={state.email} />
          </div>
        )}

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link
            href={ROUTES.signUp}
            className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline"
          >
            Sign up
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
