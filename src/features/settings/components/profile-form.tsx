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
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";

import {
  updateProfile,
  type UpdateProfileActionResult,
  type UpdateProfileField,
} from "../actions/update-profile";
import { PROFILE_NAME_MAX_LENGTH } from "../services/profile";

export const SAVE_PROFILE_LABEL = "Save changes";
export const SAVE_PROFILE_PENDING_LABEL = "Saving…";
export const PROFILE_SAVED_MESSAGE = "Your profile has been saved.";

type Props = {
  /** Current display name, derived server-side from the signed-in user. */
  fullName: string;
};

/**
 * The settings page's profile card: the display name. (Email and password have
 * their own cards: both are confirmation- or verification-driven flows.)
 *
 * Failures come back as `state.error` (+ which field, when known) and are shown
 * inline; success stays on the page with a confirmation, and the re-render that
 * follows the action brings the header's account menu in line.
 */
export function ProfileForm({ fullName }: Props) {
  const id = useId();
  const nameId = `${id}-name`;
  const errorId = `${id}-error`;

  const [state, formAction, pending] = useActionState<
    UpdateProfileActionResult,
    FormData
  >(updateProfile, null);

  const fieldError = state?.status === "error" ? state : null;
  const saved = state?.status === "saved";
  const describedBy = (field: UpdateProfileField) =>
    fieldError?.field === field ? errorId : undefined;
  const invalid = (field: UpdateProfileField) =>
    fieldError?.field === field ? true : undefined;

  return (
    // `id` is the target of the account menu's "Profile" entry (/settings#profile).
    <Card id="profile" data-settings-section="profile">
      <CardHeader>
        <CardTitle asChild>
          <h3>Profile</h3>
        </CardTitle>
        <CardDescription>How you appear across the app.</CardDescription>
      </CardHeader>

      {/* The card is a flex column; the form carries the same gap so content and
          footer keep their spacing. */}
      <form
        action={formAction}
        aria-busy={pending}
        aria-label="Profile"
        className="flex flex-col gap-4"
      >
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={nameId}>Full name</Label>
            <Input
              id={nameId}
              name="fullName"
              type="text"
              autoComplete="name"
              placeholder="Jane Doe"
              required
              maxLength={PROFILE_NAME_MAX_LENGTH}
              // React resets the form when the action settles; the echoed name
              // (what was typed, or what was saved) becomes the new default.
              defaultValue={state?.fullName ?? fullName}
              aria-invalid={invalid("fullName")}
              aria-describedby={describedBy("fullName")}
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

          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              {PROFILE_SAVED_MESSAGE}
            </p>
          )}
        </CardContent>

        <CardFooter>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? SAVE_PROFILE_PENDING_LABEL : SAVE_PROFILE_LABEL}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
