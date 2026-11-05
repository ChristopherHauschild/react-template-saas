// @vitest-environment node
import { describe, expect, it } from "vitest";

import { SUPPORT_REQUEST_SELECT, toSupportRequest } from "./support-request-row";

const ROW = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  created_at: "2026-03-01T10:00:00+00:00",
  category: "billing",
  status: "open",
  subject: "Charged twice",
  message: "I see two charges for March.",
};

describe("SUPPORT_REQUEST_SELECT", () => {
  it("never reads the owner column (a row is the user's by construction)", () => {
    expect(SUPPORT_REQUEST_SELECT).not.toContain("user_id");
  });

  it("reads every column the display type needs", () => {
    const columns = SUPPORT_REQUEST_SELECT.split(",").map((c) => c.trim());

    expect(columns.sort()).toEqual([
      "category",
      "created_at",
      "id",
      "message",
      "status",
      "subject",
    ]);
  });
});

describe("toSupportRequest", () => {
  it("maps a row to the shape the page shows", () => {
    expect(toSupportRequest(ROW)).toEqual({
      id: ROW.id,
      createdAt: ROW.created_at,
      category: "billing",
      status: "open",
      subject: ROW.subject,
      message: ROW.message,
    });
  });

  it("never carries the owner id through, even if the row has one", () => {
    const mapped = toSupportRequest({
      ...ROW,
      user_id: "11111111-1111-4111-8111-111111111111",
    });

    expect(mapped).not.toHaveProperty("user_id");
    expect(JSON.stringify(mapped)).not.toContain("1111");
  });

  it.each([
    ["an unknown category", { category: "shipping" }],
    ["a missing category", { category: null }],
  ])("keeps a request with %s, labelled as unrecognised", (_label, override) => {
    expect(toSupportRequest({ ...ROW, ...override })).toMatchObject({
      category: null,
      subject: ROW.subject,
    });
  });

  it.each([
    ["an unknown status", { status: "escalated" }],
    ["a missing status", { status: undefined }],
  ])("keeps a request with %s rather than claiming it is open", (_label, override) => {
    expect(toSupportRequest({ ...ROW, ...override })).toMatchObject({ status: null });
  });

  it.each([
    ["no id", { id: undefined }],
    ["an id that is not a uuid", { id: "42" }],
    ["no timestamp", { created_at: undefined }],
    ["an empty timestamp", { created_at: "" }],
    ["no subject", { subject: undefined }],
    ["a non-string message", { message: 12 }],
  ])("cannot display a row with %s", (_label, override) => {
    expect(toSupportRequest({ ...ROW, ...override })).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "row"],
    ["an array", []],
  ])("cannot display %s", (_label, raw) => {
    expect(toSupportRequest(raw)).toBeNull();
  });
});
