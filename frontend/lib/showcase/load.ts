import { readFileSync } from "node:fs";
import path from "node:path";

// Server-only. Reads the landing-page showcase fixture (a pinned copy of the
// demo seed's web-app template — see showcase.test.ts). The directory is
// listed in next.config `outputFileTracingIncludes` so the standalone build
// ships it.
export interface Showcase {
  resourcesYaml: string;
  uiSpecYaml: string;
}

const dir = path.join(process.cwd(), "lib", "showcase");

export function loadShowcase(): Showcase {
  return {
    resourcesYaml: readFileSync(path.join(dir, "web-app.resources.yaml"), "utf8").replaceAll("\r\n", "\n"),
    uiSpecYaml: readFileSync(path.join(dir, "web-app.ui-spec.yaml"), "utf8").replaceAll("\r\n", "\n"),
  };
}
