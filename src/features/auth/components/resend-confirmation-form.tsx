"use client";

import { useActionState, useEffect, useId, useState } from "react";

import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";

import {
  resendConfirmation,
  type ResendConfirmationActionResult,
} from "../actions/resend-confirmation";

/**
 * Seconds the button stays disabled after a request. Mirrors Supabase's default
 * per-address `max_frequency` (60s) so a patient user is never rate-limited, and
 * keeps the cost of mashing the button bounded. Applied after EVERY accepted
 * request, not only when an email went out, so it reveals nothing.
 */
export const RESEND_COOLDOWN_SECONDS = 60;

type Props = {
  /**
   * When known (the sign-up panel), the address is submitted as a hidden field
   * and the form is a single button. Otherwise (the login page after a failed
   * link) the user types it.
   */
  email?: string;
  /** Test seam; production uses {@link RESEND_COOLDOWN_SECONDS}. */
  cooldownSeconds?: number;
};

export function ResendConfirmationForm({
  email,
  cooldownSeconds = RESEND_COOLDOWN_SECONDS,
}: Props) {
  const id = useId();
  const emailId = `${id}-email`;
  const statusId = `${id}-status`;

  // The cool-down starts when a request is accepted (`sent`). The timestamp is
  // taken here, on the client, so it cannot drift against the server clock.
  const [coolingUntil, setCoolingUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [state, formAction, pending] = useActionState<
    ResendConfirmationActionResult,
    FormData
  >(async (previous, formData) => {
    const result = await resendConfirmation(previous, formData);

    if (result?.status === "sent") {
      const at = Date.now();
      setNow(at);
      setCoolingUntil(at + cooldownSeconds * 1000);
    }

    return result;
  }, null);

  useEffect(() => {
    if (coolingUntil === null) return;

    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(tick);
  }, [coolingUntil]);

  const secondsLeft =
    coolingUntil === null ? 0 : Math.max(0, Math.ceil((coolingUntil - now) / 1000));
  const coolingDown = secondsLeft > 0;
  const disabled = pending || coolingDown;

  // "sent" means the request was accepted, not that an email went out (see the
  // action): unknown, already-confirmed and rate-limited addresses get the same
  // answer. The copy acknowledges the request and nothing more.
  const requestedFor = state?.status === "sent" ? state.email : null;
  const error = state?.status === "error" ? state.error : null;

  return (
    <form action={formAction} className="space-y-3" aria-busy={pending}>
      {email === undefined ? (
        <div className="space-y-2">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            placeholder="john@company.com"
            required
            // React resets the form when the action settles; keep what was typed.
            defaultValue={state?.email ?? ""}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? statusId : undefined}
          />
        </div>
      ) : (
        <input type="hidden" name="email" value={email} />
      )}

      {/* One live region for both outcomes, so a second result replaces the first. */}
      {(requestedFor || error) && (
        <p
          id={statusId}
          role={error ? "alert" : "status"}
          className={
            error
              ? "text-sm text-red-600 dark:text-red-400"
              : "text-sm text-muted-foreground"
          }
        >
          {error ??
            `Request received. If ${requestedFor} can still be confirmed, a new link may arrive within a few minutes — check your spam folder too. Already confirmed? Just sign in.`}
        </p>
      )}

      <Button
        type="submit"
        variant="outline"
        className="w-full"
        disabled={disabled}
        aria-busy={pending}
        aria-disabled={coolingDown || undefined}
      >
        {pending
          ? "Requesting…"
          : coolingDown
            ? `Request again in ${secondsLeft}s`
            : requestedFor
              ? "Request another link"
              : "Request a new confirmation link"}
      </Button>
    </form>
  );
}
