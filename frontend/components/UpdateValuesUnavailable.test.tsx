import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithIntl } from "@/tests/intl-test-utils";
import ko from "@/messages/ko.json";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

import { UpdateValuesUnavailable } from "./UpdateValuesUnavailable";

const ID = "3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f";

// #296 — shown instead of an update form whose values could not be read.
describe("UpdateValuesUnavailable", () => {
  it("says what happened, with no form to submit", () => {
    const { container } = renderWithIntl(<UpdateValuesUnavailable releaseId={ID} />);
    expect(screen.getByRole("alert")).toHaveTextContent(ko.deploy.updateUnavailable.title);
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: /업데이트|배포/ })).toBeNull();
  });

  it("leads back to the release", () => {
    renderWithIntl(<UpdateValuesUnavailable releaseId={ID} />);
    expect(screen.getByRole("link", { name: ko.deploy.updateUnavailable.backToRelease })).toHaveAttribute(
      "href",
      `/releases/${ID}`,
    );
  });

  it("retries by reloading the page's data", async () => {
    const user = userEvent.setup();
    renderWithIntl(<UpdateValuesUnavailable releaseId={ID} />);
    await user.click(screen.getByRole("button", { name: ko.deploy.updateUnavailable.retry }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
