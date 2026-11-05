import { z } from "zod";

import {
  SUPPORT_REQUEST_CATEGORIES,
  SUPPORT_REQUEST_STATUSES,
  type SupportRequestCategory,
  type SupportRequestStatus,
} from "./support-request";

/**
 * One request as the support page shows it. Crosses into client components, so
 * it carries nothing the user did not write or cannot see: no `user_id` (the
 * row is theirs by construction — RLS and the query both say so).
 *
 * `category` and `status` are `null` when the stored value is not one this
 * version of the application knows. The database constrains both columns, so
 * that only happens across a deployment that added a value (or removed one
 * from the catalogue). The row is still shown — it is the user's own request
 * and dropping it would be worse than labelling it neutrally — but the UI must
 * handle `null` rather than print a raw identifier.
 */
export type SupportRequest = {
  id: string;
  /** ISO 8601, as stored by the server. */
  createdAt: string;
  category: SupportRequestCategory | null;
  status: SupportRequestStatus | null;
  subject: string;
  message: string;
};

/** Columns read for a request, in `select()` form. Never selects `user_id`. */
export const SUPPORT_REQUEST_SELECT =
  "id, created_at, category, status, subject, message";

/**
 * The columns as PostgREST returns them. Only the fields a request cannot be
 * displayed without are required here; `category`/`status` are read loosely and
 * narrowed afterwards.
 */
const rowSchema = z.object({
  id: z.uuid(),
  created_at: z.string().min(1),
  category: z.unknown(),
  status: z.unknown(),
  subject: z.string(),
  message: z.string(),
});

const isCategory = (value: unknown): value is SupportRequestCategory =>
  SUPPORT_REQUEST_CATEGORIES.includes(value as SupportRequestCategory);

const isStatus = (value: unknown): value is SupportRequestStatus =>
  SUPPORT_REQUEST_STATUSES.includes(value as SupportRequestStatus);

/**
 * Converts a row from PostgREST into a `SupportRequest`, or `null` when it
 * cannot be displayed at all (missing id, time or text — a schema change or a
 * mangled response). Callers count and log those rather than failing a whole
 * page.
 */
export function toSupportRequest(raw: unknown): SupportRequest | null {
  const row = rowSchema.safeParse(raw);

  if (!row.success) return null;

  return {
    id: row.data.id,
    createdAt: row.data.created_at,
    category: isCategory(row.data.category) ? row.data.category : null,
    status: isStatus(row.data.status) ? row.data.status : null,
    subject: row.data.subject,
    message: row.data.message,
  };
}
