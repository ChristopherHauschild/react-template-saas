import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { describeCsvExportCard } from "@/shared/test/csv-export-card-suite";

import { INVOICE_DOWNLOAD_PATH } from "../services/invoice-download-path";
import { INVOICE_EXPORT_FILE_BASE } from "../services/invoice-export";

import {
  downloadedText,
  INVOICE_EXPORT_COPY,
  InvoiceExportCard,
} from "./invoice-export-card";

// Everything an export card must do, against the invoice card's real path and copy.
describeCsvExportCard({
  name: "InvoiceExportCard",
  element: () => <InvoiceExportCard />,
  path: INVOICE_DOWNLOAD_PATH,
  copy: INVOICE_EXPORT_COPY,
  idPrefix: "invoice-export",
  fileBase: INVOICE_EXPORT_FILE_BASE,
});

describe("InvoiceExportCard – what it exports", () => {
  it("downloads from the invoice export route", () => {
    expect(INVOICE_DOWNLOAD_PATH).toBe("/billing/export/invoices");
  });

  it("says what the file holds, and that drafts are left out", () => {
    render(<InvoiceExportCard />);

    expect(screen.getByText("Invoices")).toBeInTheDocument();
    expect(
      screen.getByText(/date, number, status, total and currency/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Drafts are not included\./)).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Export invoices" })).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toHaveAttribute("id", "invoice-export-from");
  });
});

describe("downloadedText", () => {
  it.each([
    [null, "Downloaded a.csv."],
    [0, "Downloaded a.csv. There are no invoices in this period."],
    [1, "Downloaded a.csv with 1 invoice."],
    [2489, "Downloaded a.csv with 2,489 invoices."],
  ])("%s → %s", (rowCount, text) => {
    expect(downloadedText("a.csv", rowCount)).toBe(text);
  });
});
