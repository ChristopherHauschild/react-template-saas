import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { describeCsvExportCard } from "@/shared/test/csv-export-card-suite";

import { ACCOUNT_ACTIVITY_DOWNLOAD_PATH } from "../services/account-activity-download-path";
import { ACCOUNT_ACTIVITY_EXPORT_FILE_BASE } from "../services/account-activity-export";

import {
  ACCOUNT_ACTIVITY_EXPORT_COPY,
  AccountActivityExportCard,
  downloadedActivityText,
} from "./account-activity-export-card";

// Everything an export card must do — exactly as for invoices — against the
// activity card's real path and copy.
describeCsvExportCard({
  name: "AccountActivityExportCard",
  element: () => <AccountActivityExportCard />,
  path: ACCOUNT_ACTIVITY_DOWNLOAD_PATH,
  copy: ACCOUNT_ACTIVITY_EXPORT_COPY,
  idPrefix: "activity-export",
  fileBase: ACCOUNT_ACTIVITY_EXPORT_FILE_BASE,
});

describe("AccountActivityExportCard – what it exports", () => {
  it("downloads from the account activity export route", () => {
    expect(ACCOUNT_ACTIVITY_DOWNLOAD_PATH).toBe("/settings/export/activity");
  });

  it("says what the file holds, including entries this version cannot describe", () => {
    render(<AccountActivityExportCard />);

    expect(screen.getByText("Account activity")).toBeInTheDocument();
    expect(
      screen.getByText(/display name, email address, password and sessions/),
    ).toBeInTheDocument();
    expect(screen.getByText(/listed as such, never left out/)).toBeInTheDocument();
    expect(
      screen.getByRole("form", { name: "Export account activity" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toHaveAttribute("id", "activity-export-from");
  });
});

describe("downloadedActivityText", () => {
  it.each([
    [null, "Downloaded a.csv."],
    [0, "Downloaded a.csv. There is no account activity in this period."],
    [1, "Downloaded a.csv with 1 entry."],
    [10_000, "Downloaded a.csv with 10,000 entries."],
  ])("%s → %s", (rowCount, text) => {
    expect(downloadedActivityText("a.csv", rowCount)).toBe(text);
  });
});
