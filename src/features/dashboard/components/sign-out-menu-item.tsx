"use client";

import { useFormStatus } from "react-dom";

import { DropdownMenuItem } from "@/shared/components/ui/dropdown-menu";
import { clearAllTabDrafts } from "@/shared/utils/tab-drafts";

type Props = {
  /** Server action that ends the session and redirects; injected by the route layout. */
  action: () => Promise<void>;
};

/**
 * "Sign out" entry of the account menu, rendered as a real form submission.
 *
 * The menu must stay open while the action runs: Radix closes (unmounts) the menu
 * synchronously on select, *before* the browser performs the click's default
 * action — and a submit button that is no longer in the document submits nothing.
 * `onSelect` is therefore cancelled, and the pending state is shown in place.
 *
 * Signing out also forgets every unsent form draft kept in this tab (see
 * `@/shared/utils/tab-drafts`): drafts exist to survive an EXPIRED session,
 * not to outlive a deliberate sign-out on a possibly shared computer. The
 * submit handler does not cancel the event, so the action still runs.
 */
export function SignOutMenuItem({ action }: Props) {
  return (
    <form action={action} onSubmit={clearAllTabDrafts}>
      <SubmitItem />
    </form>
  );
}

function SubmitItem() {
  const { pending } = useFormStatus();

  return (
    <DropdownMenuItem
      asChild
      disabled={pending}
      onSelect={(event) => event.preventDefault()}
    >
      <button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </DropdownMenuItem>
  );
}
