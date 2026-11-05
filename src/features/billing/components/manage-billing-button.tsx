"use client";

import { useActionState } from "react";

import { Button } from "@/shared/components/ui/button";

import {
  createPortalSession,
  type PortalActionResult,
} from "../actions/create-portal-session";

export const MANAGE_BILLING_LABEL = "Manage billing";
export const MANAGE_BILLING_PENDING_LABEL = "Opening billing portal…";

/**
 * Opens the Stripe Customer Portal. A form submission so the server action runs
 * where the session cookies live; the action takes no input (the customer is
 * resolved from the signed-in user's own records), so the form carries none.
 *
 * Expected problems (no billing account, state unreadable) come back as
 * `state.error` and are shown inline; success redirects to Stripe; unexpected
 * failures reach the route's error boundary.
 */
export function ManageBillingButton() {
  const [state, formAction, pending] = useActionState<PortalActionResult, FormData>(
    createPortalSession,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Button type="submit" disabled={pending} aria-busy={pending} className="self-start">
        {pending ? MANAGE_BILLING_PENDING_LABEL : MANAGE_BILLING_LABEL}
      </Button>

      <p className="text-xs text-muted-foreground">
        Opens Stripe&apos;s secure billing portal to view and manage your subscription.
      </p>

      {state?.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
