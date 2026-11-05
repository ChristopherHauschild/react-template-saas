import { ConfirmationFailureBanner } from "@/features/auth/components/confirmation-failure-banner";
import { EmailChangeStatusBanner } from "@/features/auth/components/email-change-status-banner";
import { ResendConfirmationForm } from "@/features/auth/components/resend-confirmation-form";
import { SignInForm } from "@/features/auth/components/sign-in-form";
import {
  canRequestNewLink,
  parseConfirmationFailure,
} from "@/features/auth/services/email-confirmation-errors";
import { readEmailChangeStatus } from "@/features/auth/services/read-email-change-status";
import { requireGuest } from "@/infrastructure/auth/guards/require-guest";

type Props = {
  searchParams: Promise<{
    confirmation?: string | string[];
    emailChange?: string | string[];
  }>;
};

export default async function LoginPage({ searchParams }: Props) {
  await requireGuest();

  const { confirmation, emailChange } = await searchParams;
  const confirmationFailure = parseConfirmationFailure(confirmation);

  return (
    <div className="m-auto w-[350px] space-y-4">
      <ConfirmationFailureBanner failure={confirmationFailure} />
      {/* An email-change link opened in a browser without a session lands here. */}
      <EmailChangeStatusBanner
        // Only with the callback's flash cookie for a browser without a session.
        status={await readEmailChangeStatus(emailChange, { expectedUserId: null })}
        placement="login"
      />
      {confirmationFailure && canRequestNewLink(confirmationFailure) && (
        <div className="rounded-xl border border-border/60 bg-card/80 p-4 backdrop-blur">
          <ResendConfirmationForm />
        </div>
      )}
      <SignInForm />
    </div>
  );
}
