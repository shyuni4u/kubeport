import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { InstancesToggle } from "./InstancesToggle";

// #190 — the editor keeps the ui-spec's `instances` and lets an admin set it.
describe("InstancesToggle", () => {
  const box = () => screen.getByRole("checkbox", { name: "한 네임스페이스에 여러 번 배포 허용" });

  it("turns multiple on and off", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<InstancesToggle multiple={false} onChange={onChange} />);
    expect(box()).not.toBeChecked();
    expect(box()).toHaveAccessibleDescription(/버전을 하나라도 게시한 뒤에는 바꿀 수 없으니/);

    await user.click(box());
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<InstancesToggle multiple onChange={onChange} />);
    expect(box()).toBeChecked();
    await user.click(box());
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("does not change on a draft that cannot be saved", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<InstancesToggle multiple={false} onChange={onChange} readOnly />);
    await user.click(box());
    expect(onChange).not.toHaveBeenCalled();
  });
});
