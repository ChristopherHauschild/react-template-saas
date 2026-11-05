import { EmailChangeStatusBanner } from "@/features/auth/components/email-change-status-banner";
import { reconcileEmailChangeStatus } from "@/features/auth/services/email-change-status";
import { readEmailChangeStatus } from "@/features/auth/services/read-email-change-status";
import {
  ACCOUNT_ACTIVITY_PAGE_SIZE,
  AccountActivityCard,
  ChangeEmailForm,
  ChangePasswordForm,
  ProfileForm,
  SecurityCard,
  toAccountSecurity,
  toProfile,
} from "@/features/settings";
import {
  listAccountActivity,
  type ListAccountActivityResult,
} from "@/infrastructure/account-activity/list-account-activity";
import { requireAuth } from "@/infrastructure/auth/guards/require-auth";
import { getCurrentSessionInfo } from "@/infrastructure/auth/session/session-tokens";

type Props = { searchParams: Promise<{ emailChange?: string | string[] }> };

/**
 * Account settings. Profile data is the signed-in user's own Supabase record
 * (`user_metadata`, `email`, pending `new_email`), so the forms need nothing
 * beyond the session the guard already loaded and receive only display values.
 * The password card needs nothing but the email (for password managers); the
 * actions re-check the session themselves.
 *
 * The one thing read beyond the session is the first page of the account
 * activity history (as the user, under RLS). It is the only part of the page
 * that can fail on its own, and it must not take the rest down: the service
 * reports failures as a value, and `loadFirstActivityPage` turns even an
 * unexpected rejection into one, so the card says "unavailable" while the
 * forms stay usable.
 *
 * `?emailChange=` is where `/auth/callback` reports the outcome of an
 * email-change confirmation link. The value is untrusted (typed, forwarded,
 * stale): it is shown only when the HttpOnly flash cookie the callback set for
 * THIS browser and THIS user agrees with it (`readEmailChangeStatus`), and even
 * then not when the account's own record contradicts it — "confirmed" while a
 * change is still pending, "one more to go" when nothing is.
 */
export default async function SettingsPage({ searchParams }: Props) {
  // Same per-request cached lookup the (protected) layout's guard already made.
  const [user, { emailChange }] = await Promise.all([requireAuth(), searchParams]);

  const profile = toProfile(user);
  // The session cookies are read only for the access-token lifetime the
  // security copy states; the user itself comes from the guard's verified lookup.
  const [{ accessTokenLifetimeSeconds }, activity] = await Promise.all([
    getCurrentSessionInfo(),
    loadFirstActivityPage(user.id),
  ]);
  const emailChangeStatus = reconcileEmailChangeStatus(
    await readEmailChangeStatus(emailChange, { expectedUserId: user.id }),
    { changePending: profile.pendingEmail !== null },
  );

  return (
    // Forms read best at a moderate width; the cards stay full-width below it.
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="text-2xl font-bold">Settings</h2>

        <p className="text-muted-foreground text-sm">
          Manage your account and how you appear across the app.
        </p>
      </div>

      <EmailChangeStatusBanner status={emailChangeStatus} placement="settings" />

      <ProfileForm fullName={profile.fullName} />

      <ChangeEmailForm profile={profile} />

      <ChangePasswordForm
        email={profile.email}
        accessTokenLifetimeSeconds={accessTokenLifetimeSeconds}
      />

      <SecurityCard
        security={toAccountSecurity(user)}
        accessTokenLifetimeSeconds={accessTokenLifetimeSeconds}
      />

      <AccountActivityCard initial={activity} />
    </div>
  );
}

/**
 * The service never throws by contract; this guard makes the page hold even if
 * that contract were broken, because a history that cannot be shown is not a
 * reason to hide the settings. The failure is logged without user data.
 */
async function loadFirstActivityPage(userId: string): Promise<ListAccountActivityResult> {
  try {
    return await listAccountActivity(userId, { limit: ACCOUNT_ACTIVITY_PAGE_SIZE });
  } catch (thrown) {
    console.error("[settings] account activity could not be loaded for the page", {
      error: { name: thrown instanceof Error ? thrown.name : typeof thrown },
    });
    return { ok: false };
  }
}
