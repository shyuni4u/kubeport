import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { TEMPLATE_NAME_PATTERN, templateNameProblem } from "./template-name";

// The API's own document. The backend's spec test holds its pattern to the
// binding the server runs; this holds the form's copy to the document (#369).
// Tests run from frontend/ (pnpm -C frontend, and CI's working-directory); in
// the jsdom environment import.meta.url is not a file URL.
const spec = YAML.parse(
  readFileSync(resolve(process.cwd(), "../backend/api/openapi.yaml"), "utf8"),
) as {
  components: {
    parameters: Record<string, { schema?: { pattern?: string } }>;
    schemas: Record<string, { properties?: Record<string, { pattern?: string }> }>;
  };
};

describe("template name rule (#369)", () => {
  it("is the pattern openapi.yaml documents, on the path and on create", () => {
    expect(spec.components.parameters.TemplateName.schema?.pattern).toBe(TEMPLATE_NAME_PATTERN);
    expect(spec.components.schemas.CreateTemplateRequest.properties?.name.pattern).toBe(TEMPLATE_NAME_PATTERN);
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

  it("keeps what the API accepts, uppercase and dots included", () => {
    for (const name of ["Web-App", "0abc", "web.app", "a".repeat(63)]) {
      expect(templateNameProblem(name), name).toBeNull();
    }
    expect(templateNameProblem("a".repeat(64))).toBe("format");
  });

  it("tells an empty name apart", () => {
    expect(templateNameProblem("")).toBe("empty");
    expect(templateNameProblem("   ")).toBe("empty");
  });
});
