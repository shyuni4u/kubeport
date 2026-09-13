import { describe, expect, it } from "vitest";

import { withDemoSuffix } from "./demo";
import {
  RELEASE_NAME_MAX_LENGTH,
  SINGLE_INSTANCE_RULES,
  releaseNameProblem,
  releaseNameRules,
} from "./release-name";

// #190 — a multi-instance template names every object `<release>-<name>`, so
// the release name is held to what those names leave.

const resources = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
---
apiVersion: v1
kind: Service
metadata:
  name: web
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-backup
`;

const MULTIPLE = "instances: multiple\nfields: []\n";

describe("releaseNameRules", () => {
  it("leaves a single-instance template's release name as it was", () => {
    expect(releaseNameRules("fields: []\n", resources)).toEqual(SINGLE_INSTANCE_RULES);
    expect(releaseNameRules("instances: single\nfields: []\n", resources)).toEqual(SINGLE_INSTANCE_RULES);
  });

  it("fits every object's new name, a CronJob's in 52", () => {
    // nightly-backup: 52 - 1 - 14 = 37, under what web leaves (63 - 1 - 3).
    expect(releaseNameRules(MULTIPLE, resources)).toEqual({
      multiple: true,
      maxLength: 37,
      letterFirst: true,
    });
  });

  it("asks for a letter first only when a Service takes the name", () => {
    const configOnly = "kind: ConfigMap\nmetadata:\n  name: settings\n";
    expect(releaseNameRules(MULTIPLE, configOnly)).toEqual({
      multiple: true,
      maxLength: 54,
      letterFirst: false,
    });
  });

  // Code review: the library refuses to expand this many aliases, and the
  // deploy page computes the rules on the server, where a throw is a 500.
  it("skips a document with more aliases than the library expands", () => {
    const aliases = Array.from({ length: 150 }, (_, i) => `  k${i}: *v\n`).join("");
    const bomb = `kind: ConfigMap\nmetadata:\n  name: settings\ndata:\n  a: &v x\n${aliases}---\nkind: Service\nmetadata:\n  name: web\n`;
    expect(releaseNameRules(MULTIPLE, bomb)).toEqual({
      multiple: true,
      maxLength: 59,
      letterFirst: true,
    });
  });

  it("does not fail the page on YAML it cannot read", () => {
    expect(releaseNameRules("instances: [", resources)).toEqual(SINGLE_INSTANCE_RULES);
    expect(releaseNameRules(MULTIPLE, "kind: [")).toEqual({
      multiple: true,
      maxLength: RELEASE_NAME_MAX_LENGTH,
      letterFirst: false,
    });
  });
});

describe("releaseNameProblem under a multi-instance template's rules", () => {
  const rules = { multiple: true, maxLength: 37, letterFirst: true };

  it("allows exactly what the objects leave and no more", () => {
    expect(releaseNameProblem("a".repeat(37), rules)).toBeNull();
    expect(releaseNameProblem("a".repeat(38), rules)).toBe("tooLong");
  });

  it("wants a letter first for the Service, and only then", () => {
    expect(releaseNameProblem("2048-game", rules)).toBe("letterFirst");
    expect(releaseNameProblem("2048-game")).toBeNull();
  });
});

describe("withDemoSuffix under a multi-instance template's rules", () => {
  const rules = { multiple: true, maxLength: 37, letterFirst: true };

  it.each(["web-app", "a".repeat(80), "2048-game", "한글", "123"])(
    "prefills %j with a name the form accepts",
    (name) => {
      for (const rand of [() => 0, () => 0.99, Math.random]) {
        expect(releaseNameProblem(withDemoSuffix(name, true, rand, rules), rules)).toBeNull();
      }
    },
  );

  it("keeps the single-instance default as it was", () => {
    expect(withDemoSuffix("web-app", true, () => 0)).toBe("web-app-aaaa");
    expect(withDemoSuffix("2048-game", true, () => 0)).toBe("2048-game-aaaa");
  });
});
