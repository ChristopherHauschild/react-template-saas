/**
 * Where the account activity CSV download is served
 * (`src/app/(protected)/(dashboard)/settings/export/activity/route.ts`). In its
 * own module so client components can link to it: the download service
 * itself is server-only.
 */
export const ACCOUNT_ACTIVITY_DOWNLOAD_PATH = "/settings/export/activity";
