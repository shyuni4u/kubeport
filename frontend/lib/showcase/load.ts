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

// The landing page is dynamic (cookie-dependent), so cache the file reads for
// the process lifetime instead of hitting disk on every request.
let cached: Showcase | null = null;

export function loadShowcase(): Showcase {
  if (!cached) {
    cached = {
      resourcesYaml: readFileSync(path.join(dir, "web-app.resources.yaml"), "utf8").replaceAll("\r\n", "\n"),
      uiSpecYaml: readFileSync(path.join(dir, "web-app.ui-spec.yaml"), "utf8").replaceAll("\r\n", "\n"),
    };
  }
  return cached;
}
