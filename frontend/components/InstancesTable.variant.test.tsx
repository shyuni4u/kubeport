import { describe, it, expect } from "vitest";
import { instanceVariant } from "./InstancesTable";

// The chip shows the pod's reason when it has one (#33), but its colour reads
// the reason and the phase together. Reading the reason alone turned every
// reason the patterns did not know grey — "inactive" — even on a Failed pod,
// under a red "오류" header.
describe("instanceVariant with reason and phase", () => {
  it.each([
    ["InvalidImageName Pending", "danger"],
    ["DeadlineExceeded Failed", "danger"],
    ["ImagePullBackOff Pending", "danger"],
    ["OOMKilled Running", "danger"],
    ["SchedulingGated Pending", "warning"],
    ["Unschedulable Pending", "warning"],
    ["Running", "muted"],
  ])("%s → %s", (label, want) => {
    expect(instanceVariant(false, label)).toBe(want);
  });

  it("is success whenever the pod is ready", () => {
    expect(instanceVariant(true, "Running")).toBe("success");
  });
});
