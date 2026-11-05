import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CSV_EXPORT_COMMON_COPY,
  CsvExportCard,
  type CsvExportCopy,
  downloadedCountText,
} from "./csv-export-card";

const copy = (label: string): CsvExportCopy => ({
  ...CSV_EXPORT_COMMON_COPY,
  title: label,
  description: `All the ${label}.`,
  formLabel: `Export ${label}`,
  datesHint: "UTC days.",
  progress: "Preparing…",
  downloaded: (fileName, rowCount) =>
    downloadedCountText(fileName, rowCount, {
      one: "thing",
      other: "things",
      none: "None.",
    }),
});

describe("downloadedCountText", () => {
  const words = { one: "row", other: "rows", none: "Nothing in this period." };

  it.each([
    [null, "Downloaded a.csv."],
    [0, "Downloaded a.csv. Nothing in this period."],
    [1, "Downloaded a.csv with 1 row."],
    [2, "Downloaded a.csv with 2 rows."],
    [1234567, "Downloaded a.csv with 1,234,567 rows."],
  ])("%s → %s", (rowCount, text) => {
    expect(downloadedCountText("a.csv", rowCount, words)).toBe(text);
  });
});

describe("CsvExportCard – several on one page", () => {
  it("gives each card its own ids, so labels, hints and errors never point into another card", () => {
    render(
      <>
        <CsvExportCard
          path="/a/export"
          copy={copy("apples")}
          idPrefix="apples-export"
          exportName="apples"
          signInHref="/login"
        />
        <CsvExportCard
          path="/b/export"
          copy={copy("pears")}
          idPrefix="pears-export"
          exportName="pears"
          signInHref="/login"
        />
      </>,
    );

    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const name of ["apples", "pears"]) {
      const form = screen.getByRole("form", { name: `Export ${name}` });
      const from = within(form).getByLabelText("From");
      expect(from.id).toBe(`${name}-export-from`);
      expect(from).toHaveAccessibleDescription("UTC days.");
    }
  });
});
