import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SUPPORT_HISTORY_COPY as COPY } from "../services/support-request-history";

import { SupportRequestHistorySkeleton } from "./support-request-history-skeleton";

describe("SupportRequestHistorySkeleton", () => {
  it("is the history's region, busy, with its real heading", () => {
    render(<SupportRequestHistorySkeleton />);

    const region = screen.getByRole("region", { name: COPY.title });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveAttribute("data-history-state", "loading");
    expect(within(region).getByRole("heading", { level: 3 })).toHaveTextContent(
      COPY.title,
    );
  });

  it("tells screen readers the list is loading; the placeholder bars are hidden from them", () => {
    const { container } = render(<SupportRequestHistorySkeleton />);

    expect(screen.getByRole("status")).toHaveTextContent(COPY.loadingAnnouncement);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"] .animate-pulse')).not.toBeNull();
  });

  it("claims nothing about the user's requests while loading", () => {
    render(<SupportRequestHistorySkeleton />);

    expect(screen.queryByText(COPY.empty)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
