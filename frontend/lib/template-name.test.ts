import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { TEMPLATE_NAME_MAX_LENGTH, TEMPLATE_NAME_PATTERN, templateNameProblem } from "./template-name";

// The API's own document. The backend's spec test holds its pattern and
// maxLength to what the server accepts; this holds the form's copy to the
// document (#369). Tests run from frontend/ (pnpm -C frontend, and CI's
// `cd frontend`); in the jsdom environment import.meta.url is not a file URL.
type NameSchema = { pattern?: string; maxLength?: number };
const spec = YAML.parse(
  readFileSync(resolve(process.cwd(), "../backend/api/openapi.yaml"), "utf8"),
) as {
  components: {
    parameters: Record<string, { schema?: NameSchema }>;
    schemas: Record<string, { properties?: Record<string, NameSchema> }>;
  };
};

describe("template name rule (#369)", () => {
  it("is the pattern and length openapi.yaml documents, on the path and on create", () => {
    const onPath = spec.components.parameters.TemplateName.schema;
    const onCreate = spec.components.schemas.CreateTemplateRequest.properties?.name;
    for (const s of [onPath, onCreate]) {
      expect(s?.pattern).toBe(TEMPLATE_NAME_PATTERN);
      expect(s?.maxLength).toBe(TEMPLATE_NAME_MAX_LENGTH);
    }
  });

  it("passes the demo seed's names", () => {
    for (const name of ["web-app", "nightly-job", "app-with-config"]) {
      expect(templateNameProblem(name), name).toBeNull();
    }
  });

  it("refuses what no template route can reach", () => {
    for (const name of ["my/app", "my app", "..", ".web", "web.", "-web", "web_app", "a?b", "a#b", "웹앱"]) {
      expect(templateNameProblem(name), name).toBe("format");
    }
  });

  // The name is also the kubeport.io/template label on every object a release
  // creates, so a name the apiserver refuses as a label value would make the
  // template undeployable (master review).
  it("refuses what could not be a label value", () => {
    for (const name of ["web-", "a.-b", "a".repeat(64), Array(20).fill("app").join(".")]) {
      expect(templateNameProblem(name), name).toBe("format");
    }
  });

  it("keeps what the API accepts, uppercase and dots included", () => {
    for (const name of ["Web-App", "0abc", "web.app", "a-.b", "a--b", "a", "a".repeat(63)]) {
      expect(templateNameProblem(name), name).toBeNull();
    }
  });

  it("tells an empty name apart", () => {
    expect(templateNameProblem("")).toBe("empty");
    expect(templateNameProblem("   ")).toBe("empty");
  });
});
