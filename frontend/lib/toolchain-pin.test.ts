import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// The gates must run the toolchain the images ship with. #471 bumped the Go
// builder image alone and CI kept checking with go.mod's older toolchain
// (#489); playwright.yml ran the app on Node 20 while the image is 24 (#488).
// dependabot bumps Dockerfile base images without touching the rest, so the
// pairs are checked here.
describe("toolchain pin", () => {
  it("runs the app-facing workflow jobs on the image's Node major", () => {
    const majors = [
      ...read("frontend/Dockerfile").matchAll(/FROM node:(\d+)-alpine/g),
    ].map((m) => m[1]);
    expect(majors.length).toBeGreaterThan(0);
    expect(new Set(majors).size).toBe(1);
    const image = majors[0];

    // ci.yml's frontend/audit jobs and playwright.yml's app run. The cli
    // (22) and hooks (20) jobs do not run the app and are left out.
    const ci = read(".github/workflows/ci.yml");
    const frontendJob = ci.slice(ci.indexOf("\n  frontend:"), ci.indexOf("\n  audit:"));
    expect(frontendJob).toMatch(new RegExp(`node-version: ${image}\\b`));
    const playwright = [
      ...read(".github/workflows/playwright.yml").matchAll(/node-version: (\d+)/g),
    ].map((m) => m[1]);
    expect(playwright).toEqual([image]);
  });

  it("checks the backend with the Go toolchain the image builds with", () => {
    const image = read("backend/Dockerfile").match(/golang:(\d+\.\d+\.\d+)-alpine/)?.[1];
    const toolchain = read("backend/go.mod").match(/^toolchain go(\S+)$/m)?.[1];
    expect(image).toBeDefined();
    expect(toolchain).toBe(image);
  });
});
