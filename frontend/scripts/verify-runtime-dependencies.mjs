// GHSA-fc5q-39xc-vjpf: the approved temporary exception relies on Parcel's
// build/dev watcher being absent from the shipped standalone runtime.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = '.next';
const traces = readdirSync(root, { recursive: true })
  .filter(path => path.endsWith('.nft.json') && !path.startsWith('standalone/'));
if (!traces.length) throw new Error('No Next build traces found');
for (const trace of traces) {
  const { files } = JSON.parse(readFileSync(join(root, trace), 'utf8'));
  for (const file of files) {
    // Next's separately bundled compiled/picomatch is not this npm chain.
    if (/node_modules\/(?:@parcel\/watcher|picomatch)\//.test(file.replaceAll('\\', '/'))) {
      throw new Error(`Reassess picomatch exception: ${trace} ships ${file}`);
    }
  }
}
const { config } = JSON.parse(readFileSync(join(root, 'required-server-files.json'), 'utf8'));
if (config.images?.unoptimized !== true || config.images.remotePatterns?.length) {
  throw new Error('Reassess picomatch exception before enabling image pattern consumers');
}
console.log(`Runtime dependency boundary verified across ${traces.length} build traces`);
