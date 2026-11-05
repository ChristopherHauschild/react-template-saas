import { DismissQueryParamButton } from "@/shared/components/ui/dismiss-query-param-button";

import {
  EMAIL_CHANGE_QUERY_PARAM,
  EMAIL_CHANGE_STATUSES,
  type EmailChangeStatus,
} from "../services/email-change-status";

type Tone = "success" | "info" | "error";

type Copy = { title: string; body: string; tone: Tone };

/**
 * Where the banner is shown decides the remedy sentence: on the settings page the
 * Email card is right below; on the login page the user has to sign in first.
 */
type Placement = "settings" | "login";

const CONTENT: Record<EmailChangeStatus, Record<Placement, Copy>> = {
  [EMAIL_CHANGE_STATUSES.confirmed]: {
    settings: {
      tone: "success",
      title: "Your email address has been changed",
      body: "Use the new address the next time you sign in. The old one no longer belongs to this account.",
    },
    login: {
      tone: "success",
      title: "Your email address has been changed",
      body: "Sign in with the new address from now on.",
    },
  },
  [EMAIL_CHANGE_STATUSES.awaitingOther]: {
    settings: {
      tone: "info",
      title: "One link confirmed — one more to go",
      body: "For your security, both your current and your new address have to approve the change. Open the link sent to the other address to complete it. Until then your email stays as it is.",
    },
    login: {
      tone: "info",
      title: "One link confirmed — one more to go",
      body: "Both your current and your new address have to approve the change. Open the link sent to the other address to complete it. Until then, sign in with your current address.",
    },
  },
  [EMAIL_CHANGE_STATUSES.expired]: {
    settings: {
      tone: "error",
      title: "That email-change link has expired",
      body: "Opening it changed nothing. If you still want to change your address, request a new link from the Email section below and open it within the hour.",
    },
    login: {
      tone: "error",
      title: "That email-change link has expired",
      body: "Opening it changed nothing. Sign in with your current address and, if you still want to change it, request a new link from Settings.",
    },
  },
  [EMAIL_CHANGE_STATUSES.invalid]: {
    settings: {
      tone: "error",
      title: "That email-change link didn't work",
      body: "It may be incomplete or already used, so opening it changed nothing. If you still want to change your address, request a new link from the Email section below.",
    },
    login: {
      tone: "error",
      title: "That email-change link didn't work",
      body: "It may be incomplete or already used, so opening it changed nothing. Sign in with your current address and request a new link from Settings if you still want to change it.",
    },
  },
  [EMAIL_CHANGE_STATUSES.unavailable]: {
    settings: {
      tone: "error",
      title: "We couldn't confirm the change right now",
      body: "Something went wrong on our end; your link may still be fine. Try it again in a moment. If it then reports as used, check the address shown below.",
    },
    login: {
      tone: "error",
      title: "We couldn't confirm the change right now",
      body: "Something went wrong on our end; your link may still be fine. Try it again in a moment.",
    },
  },
};

const TONE_CLASS: Record<Tone, string> = {
  success:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  info: "border-border bg-muted text-foreground",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
};

/**
 * Shown after the user opened an email-change confirmation link
 * (`/auth/callback` redirects to `?emailChange=<status>`).
 *
 * `status` is a closed, URL-safe token this app generated itself — never the
 * query parameter's raw text — so mapping it straight to copy is safe. Only
 * `confirmed` says the address changed; every other status says it did not.
 */
export function EmailChangeStatusBanner({
  status,
  placement,
}: {
  status: EmailChangeStatus | null;
  placement: Placement;
}) {
  if (!status) return null;

  const { title, body, tone } = CONTENT[status][placement];

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-email-change-status={status}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${TONE_CLASS[tone]}`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="mt-1 opacity-90">{body}</p>
      </div>

      {/* The status arrived in the URL; dismissing removes it so it does not
          outlive the event (it would otherwise survive every later save and reload). */}
      <DismissQueryParamButton
        param={EMAIL_CHANGE_QUERY_PARAM}
        label="Dismiss email change notice"
      />
    </div>
  );
}
