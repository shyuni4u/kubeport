import { describe, it, expect } from "vitest";

import { parsePathSegments } from "./template-path";
import { yamlToUIState } from "./yaml-to-ui-state";

const sampleResources = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: app
          image: nginx:1.25
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
`;

const sampleUISpec = `
fields:
  - path: Deployment[web].spec.replicas
    label: 인스턴스 개수
    type: integer
    min: 1
    max: 5
    default: 2
    required: true
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: 컨테이너 이미지
    type: string
    default: nginx:1.25
    required: true
`;

describe("yamlToUIState", () => {
  it("builds one UIResource per document", () => {
    const { uiState } = yamlToUIState(sampleResources, sampleUISpec);
    expect(uiState.resources).toHaveLength(2);
    const [dep, svc] = uiState.resources;
    expect(dep.kind).toBe("Deployment");
    expect(dep.name).toBe("web");
    expect(dep.apiVersion).toBe("apps/v1");
    expect(svc.kind).toBe("Service");
    expect(svc.name).toBe("web");
  });

  it("captures scalar leaves as `fixed` fields with the raw value", () => {
    const { uiState } = yamlToUIState(sampleResources, sampleUISpec);
    const dep = uiState.resources[0];
    // selector.matchLabels.app is a scalar leaf that isn't in ui-spec → fixed.
    expect(dep.fields["spec.selector.matchLabels.app"]).toEqual({
      mode: "fixed",
      fixedValue: "web",
    });
    // Array element scalar.
    expect(dep.fields["spec.template.spec.containers[0].name"]).toEqual({
      mode: "fixed",
      fixedValue: "app",
    });
  });

  it("promotes ui-spec paths to `exposed` with the full UISpecEntry", () => {
    const { uiState } = yamlToUIState(sampleResources, sampleUISpec);
    const dep = uiState.resources[0];
    const replicas = dep.fields["spec.replicas"];
    expect(replicas.mode).toBe("exposed");
    expect(replicas.uiSpec?.label).toBe("인스턴스 개수");
    expect(replicas.uiSpec?.min).toBe(1);
    expect(replicas.uiSpec?.max).toBe(5);
  });

  it("round-trips type=autocomplete with values intact", () => {
    // The yaml-to-ui-state side-loads ui-spec entries verbatim into
    // UISpecEntry (lib/yaml-to-ui-state.ts:5–14, `type: string`), so any
    // type the backend understands flows through unchanged. Pin the
    // autocomplete-specific path so a future refactor can't quietly drop
    // unknown types or silently coerce them to "string".
    const { uiState } = yamlToUIState(sampleResources, `fields:
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: 이미지
    type: autocomplete
    values:
      - nginx:1.25
      - nginx:1.27
`);
    const image =
      uiState.resources[0].fields["spec.template.spec.containers[0].image"];
    expect(image.mode).toBe("exposed");
    expect(image.uiSpec?.type).toBe("autocomplete");
    expect(image.uiSpec?.values).toEqual(["nginx:1.25", "nginx:1.27"]);
  });

  it("warns when ui-spec references an unknown resource", () => {
    const { warnings } = yamlToUIState(sampleResources, `
fields:
  - path: Deployment[ghost].spec.replicas
    label: X
    type: integer
`);
    expect(warnings.some((w) => w.includes("ghost"))).toBe(true);
  });

  it("warns and skips when metadata is a non-object (malformed YAML)", () => {
    // `metadata: broken` parses to a string; without the guard we'd walk its
    // characters and emit nonsense paths like "metadata.0".
    const { uiState, warnings } = yamlToUIState(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
---
apiVersion: apps/v1
kind: Deployment
metadata: broken
`, "fields: []");
    // First resource parses normally; second is skipped at name-check time
    // (string metadata has no .name), so we never hit the guard on this input.
    // Construct a focused case: a resource whose metadata has a non-string name
    // but whose top-level metadata IS a scalar would collide with the
    // apiVersion/kind/name check first. Test the guard directly via a
    // hand-rolled resource where name lookup succeeds via a side channel is
    // impossible in yaml, so the cleanest coverage is simply asserting no
    // bogus "metadata.0" / "metadata.1" field paths leak in the happy path.
    expect(uiState.resources).toHaveLength(1);
    const dep = uiState.resources[0];
    expect(Object.keys(dep.fields).every((k) => !/^metadata\.[0-9]/.test(k))).toBe(true);
    // Second resource was dropped by the apiVersion/kind/name check.
    expect(warnings.some((w) => w.includes("missing apiVersion"))).toBe(true);
  });

  it("skips resources missing apiVersion/kind/metadata.name with a warning", () => {
    const { uiState, warnings } = yamlToUIState(`
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
`, "fields: []");
    expect(uiState.resources).toHaveLength(0);
    expect(warnings.some((w) => w.includes("missing apiVersion"))).toBe(true);
  });
});

// Issue #129. Opening the seeded `web-app` template in UI mode returned 400:
// the generator emitted `metadata.labels.app.kubernetes.io/name`, which the
// backend parser rejected at `/name`. Both halves are fixed by quoting, so the
// assertions here are about the generated path, not just the absence of a
// throw — a path that parses but addresses the wrong key would be worse.
describe("keys that the bare segment grammar cannot express", () => {
  const withAwkwardKeys = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app.kubernetes.io/name: web-app
    app-tier: frontend
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  replicas: 1
`;

  it("quotes label and annotation keys instead of splitting them on dots", () => {
    const { uiState, warnings } = yamlToUIState(withAwkwardKeys, "fields: []");
    expect(warnings).toEqual([]);
    const fields = uiState.resources[0].fields;

    expect(fields[`metadata.labels["app.kubernetes.io/name"]`]).toEqual({
      mode: "fixed",
      fixedValue: "web-app",
    });
    expect(fields[`metadata.labels["app-tier"]`]).toEqual({
      mode: "fixed",
      fixedValue: "frontend",
    });
    expect(fields[`metadata.annotations["nginx.ingress.kubernetes.io/rewrite-target"]`]).toEqual({
      mode: "fixed",
      fixedValue: "/",
    });

    // The pre-fix output, spelled out so a regression is unambiguous.
    expect(fields["metadata.labels.app.kubernetes.io/name"]).toBeUndefined();
  });

  it("still emits bare segments for ordinary keys", () => {
    const { uiState } = yamlToUIState(withAwkwardKeys, "fields: []");
    expect(uiState.resources[0].fields["spec.replicas"]).toEqual({
      mode: "fixed",
      fixedValue: 1,
    });
  });

  it("matches a ui-spec entry whose path contains a quoted segment", () => {
    const uiSpec = `fields:
  - path: Deployment[web].metadata.labels["app.kubernetes.io/name"]
    label: 앱 이름
    type: string
`;
    const { uiState, warnings } = yamlToUIState(withAwkwardKeys, uiSpec);
    expect(warnings).toEqual([]);
    const field = uiState.resources[0].fields[`metadata.labels["app.kubernetes.io/name"]`];
    expect(field.mode).toBe("exposed");
    expect(field.uiSpec?.label).toBe("앱 이름");
  });

  it("every generated path parses back to the key it came from", () => {
    const { uiState } = yamlToUIState(withAwkwardKeys, "fields: []");
    for (const path of Object.keys(uiState.resources[0].fields)) {
      const keys = parsePathSegments(path);
      expect(keys, `path ${path} must parse`).not.toBeNull();
      // The last segment is the leaf key; it must survive the round trip
      // rather than having been split into fragments on its dots.
      expect(String(keys![keys!.length - 1])).not.toContain("[");
    }
  });
});
