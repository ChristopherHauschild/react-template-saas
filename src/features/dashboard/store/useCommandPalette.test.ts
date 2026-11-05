import { beforeEach, describe, expect, it } from "vitest";

import { useCommandPalette } from "./useCommandPalette";

describe("useCommandPalette store", () => {
  beforeEach(() => {
    useCommandPalette.setState({ open: false });
  });

  it("is closed by default", () => {
    expect(useCommandPalette.getState().open).toBe(false);
  });

  it("opens, closes and toggles", () => {
    useCommandPalette.getState().openPalette();
    expect(useCommandPalette.getState().open).toBe(true);

    useCommandPalette.getState().closePalette();
    expect(useCommandPalette.getState().open).toBe(false);

    useCommandPalette.getState().togglePalette();
    expect(useCommandPalette.getState().open).toBe(true);

    useCommandPalette.getState().setOpen(false);
    expect(useCommandPalette.getState().open).toBe(false);
  });
});
