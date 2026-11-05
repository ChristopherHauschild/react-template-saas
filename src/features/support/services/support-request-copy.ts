import type { SupportRequestCategory } from "./support-request";

/**
 * What the support form calls each category. Exhaustive over the catalogue:
 * adding a category without a label is a type error, so a raw identifier can
 * never reach the page.
 */
export const SUPPORT_REQUEST_CATEGORY_LABELS: Record<SupportRequestCategory, string> = {
  account: "My account",
  billing: "Billing",
  technical: "Something isn't working",
  other: "Something else",
};

export const SUPPORT_REQUEST_FORM_COPY = {
  title: "Contact support",
  description: "Tell us what you need help with and we'll look into it.",
  categoryLegend: "What is this about?",
  subjectLabel: "Subject",
  subjectPlaceholder: "A short summary",
  messageLabel: "Message",
  messagePlaceholder:
    "What happened, what you expected, and anything you've already tried.",
  submit: "Send request",
  submitPending: "Sending…",
  signInAgain: "Sign in again (opens a new tab)",
  draftRestored: "We've put back the request you hadn't sent yet.",
  discardDraft: "Discard it",
} as const;

/** Confirmation after a request is filed; names it when the server echoed it. */
export function supportRequestSentMessage(subject: string | null): string {
  return subject === null
    ? "Your request has been sent."
    : `Your request \u201C${subject}\u201D has been sent.`;
}
