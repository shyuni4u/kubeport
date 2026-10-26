import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Copy the lockfile-installed distribution, never fetch executable CDN code.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "node_modules/monaco-editor");
const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (pkg.devDependencies["monaco-editor"] !== version) throw new Error("Monaco must match its exact package pin");
const target = join(root, "public/vendor/monaco", version);
await mkdir(target, { recursive: true });
await cp(join(source, "min"), join(target, "min"), { recursive: true });
for (const name of ["LICENSE", "ThirdPartyNotices.txt"]) {
  await cp(join(source, name), join(target, name));
}
