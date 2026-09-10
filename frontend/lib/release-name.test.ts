import { describe, expect, it } from "vitest";

import { RELEASE_NAME_MAX_LENGTH, releaseNameProblem } from "./release-name";

describe("releaseNameProblem", () => {
  it.each(["a", "0", "my-app", "web-app-x7k2", "a1-b2-c3"])("accepts %j", (name) => {
    expect(releaseNameProblem(name)).toBeNull();
  });

  it.each(["", "   "])("reports %j as empty", (name) => {
    expect(releaseNameProblem(name)).toBe("empty");
  });

  // The first one is the reviewer's input from #182, which the form used to
  // accept silently and the API then refused with a 400.
  it.each([
    "Web App 배포 테스트 1",
    "MyApp",
    "my_app",
    "my.app",
    "-app",
    "app-",
    " my-app",
  ])("reports %j as a format problem", (name) => {
    expect(releaseNameProblem(name)).toBe("format");
  });

  it("allows exactly the label-value limit and no more", () => {
    expect(releaseNameProblem("a".repeat(RELEASE_NAME_MAX_LENGTH))).toBeNull();
    expect(releaseNameProblem("a".repeat(RELEASE_NAME_MAX_LENGTH + 1))).toBe("tooLong");
  });
});
