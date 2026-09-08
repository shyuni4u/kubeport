import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadShowcase } from "./load";

// The landing-page comparison embeds a copy of the demo seed's web-app
// fixture (the frontend Docker build context cannot see backend/). This test
// pins the copy to the backend original so the landing never drifts from what
// "사용자로 체험" actually deploys.
const backendFixtures = path.resolve(__dirname, "../../../backend/cmd/seed-demo/fixtures");

describe("showcase fixtures", () => {
  it.each(["web-app.resources.yaml", "web-app.ui-spec.yaml"])("%s matches the backend seed fixture", (file) => {
    const ours = readFileSync(path.join(__dirname, file), "utf8").replaceAll("\r\n", "\n");
    const theirs = readFileSync(path.join(backendFixtures, file), "utf8").replaceAll("\r\n", "\n");
    expect(ours).toBe(theirs);
  });

  it("loadShowcase returns both documents", () => {
    const s = loadShowcase();
    expect(s.resourcesYaml).toContain("kind: Deployment");
    expect(s.uiSpecYaml).toContain("fields:");
  });
});
