#!/usr/bin/env node
// Node 22+, no npm dependencies. Connect only to the explicitly selected install.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

export function installationUrl(raw) {
  if (!raw) throw new Error('Specify your installation with --url or KUBEPORT_URL. There is no default server.');
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The installation URL must be an origin, without credentials, path, query or fragment.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('HTTPS is required (HTTP is allowed only on loopback for local development).');
  }
  return url.origin;
}

export function apiUrl(origin, path) {
  if (!path.startsWith('/v1/') || /[\\#\s]/.test(path)) throw new Error('Use a /v1/<resource> API path.');
  const pathname = path.split('?')[0];
  for (const encoded of pathname.slice(4).split('/')) {
    const part = decodeURIComponent(encoded);
    if (!part || part === '.' || part === '..' || /[\\/%?#\x00-\x1f]/.test(part)) {
      throw new Error('Unsafe API path segment.');
    }
  }
  const result = new URL(`/api/cli${path}`, origin);
  if (result.origin !== origin || result.pathname !== `/api/cli${pathname}`) throw new Error('Unsafe API path.');
  return result.href;
}

function segment(value) {
  if (!value) throw new Error('A resource name or ID is required.');
  return encodeURIComponent(value);
}

export async function request(origin, token, method, path, body, seconds) {
  if (!/^kbp_cli_[A-Za-z0-9_-]{40,1024}$/.test(token ?? '')) {
    throw new Error('No valid CLI credential. Run login or set KUBEPORT_TOKEN.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (seconds ?? 30) * 1000);
  let response;
  try {
    response = await fetch(apiUrl(origin, path), {
      method, redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    const limit = seconds ? 1024 * 1024 : 8 * 1024 * 1024;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > limit) {
            truncated = true;
            await reader.cancel();
            break;
          }
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        if (!seconds || !controller.signal.aborted || !response.ok) throw error;
        truncated = true;
      } finally {
        reader.releaseLock();
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (seconds && response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
      // Keep only complete frames; preserve cursor IDs and all named events.
      const frames = raw.replace(/\r\n/g, '\n').split('\n\n');
      frames.pop();
      const events = frames.flatMap(frame => {
        const event = { event: 'message', data: '' };
        const data = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event.event = line.slice(6).trim();
          if (line.startsWith('id:')) event.id = line.slice(3).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) return [];
        event.data = data.join('\n');
        try { event.data = JSON.parse(event.data); } catch { /* retain text */ }
        return [event];
      });
      // EOF alone is not the API's completion signal: a proxy may close a
      // dropped stream cleanly. Only the named end event proves completion.
      truncated ||= !events.some(e => e.event === 'end');
      return { ok: !events.some(e => e.event === 'error'), status: response.status, data: { events, truncated } };
    }
    if (truncated) throw new Error('Response exceeded the output limit. Narrow the query.');
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); }
      catch { throw new Error(`Expected JSON from kubeport (HTTP ${response.status}); check the installation URL and version.`); }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Request timed out; check current state before retrying a write.');
    // Do not echo request headers or fetch error causes, which may contain credentials.
    if (error instanceof TypeError) throw new Error('Connection failed or redirected; check the installation URL, TLS and network.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function configPath() {
  return process.env.KUBEPORT_CONFIG ? resolve(process.env.KUBEPORT_CONFIG) : join(homedir(), '.kubeport', 'credentials.json');
}

async function config() {
  try { return JSON.parse(await readFile(configPath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read kubeport credentials. Check KUBEPORT_CONFIG.'); }
}

async function saveConfig(value) {
  const filename = configPath();
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

async function readCredential() {
  if (!process.stdin.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 2048) throw new Error('Credential input is too long.');
    }
    return value.trim();
  }
  // readline handles paste/backspace; discard its echo so the credential is
  // neither in shell history nor visible to terminal transcripts/screenshots.
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write('Connection token (hidden): ');
  try {
    return await new Promise((resolveToken, reject) => {
      rl.once('SIGINT', () => reject(new Error('Login cancelled.')));
      rl.once('close', () => reject(new Error('Login cancelled.')));
      rl.question('', answer => resolveToken(answer.trim()));
    });
  } finally { rl.close(); process.stderr.write('\n'); }
}

async function jsonFile(filename) {
  if (!filename) throw new Error('--file <JSON file> is required.');
  if ((await lstat(filename)).size > 4 * 1024 * 1024) throw new Error('Request file exceeds 4 MiB.');
  return JSON.parse(await readFile(filename, 'utf8'));
}

export async function main(args = process.argv.slice(2)) {
  const { values: opts, positionals: words } = parseArgs({ args, allowPositionals: true, options: {
    url: { type: 'string' }, file: { type: 'string' }, version: { type: 'string' },
    'release-id': { type: 'string' }, seconds: { type: 'string' }, help: { type: 'boolean' },
  } });
  const [command, name, version] = words;
  if (opts.help || !command) {
    console.log(`kubeport (Node 22+) — connect to your own installation
  login --url https://your-kubeport.example  Read a token from the hidden prompt/stdin
  logout                                  Delete the local credential only
  whoami | clusters | templates [name [version]] | releases [id]
  render <template> --version N --file values.json [--release-id ID]
  deploy --file release.json               Create a release
  update <id> --file update.json           Update a release
  delete <id>                             Delete a release and its managed resources
  logs <id> [--seconds 10]                 Bounded SSE snapshot (1–60 seconds)
  api <METHOD> </v1/path?query> [--file body.json]
Environment: KUBEPORT_URL, KUBEPORT_TOKEN, KUBEPORT_CONFIG.
No default host, telemetry, redirects or automatic write retries.
Tokens use your browser session's permissions and expire within one hour.
Sign out of that browser session to revoke; local logout alone does not revoke.`);
    return;
  }
  const counts = { login: 1, logout: 1, whoami: 1, clusters: 1, templates: 3, releases: 2,
    render: 2, deploy: 1, update: 2, delete: 2, logs: 2, api: 3 };
  if (!(command in counts) || words.length > counts[command]) throw new Error('Unknown command or extra arguments. Use --help.');
  const commandOptions = {
    login: [], logout: [], whoami: [], clusters: [], templates: [], releases: [],
    render: ['file', 'version', 'release-id'], deploy: ['file'], update: ['file'],
    delete: [], logs: ['seconds'], api: ['file'],
  };
  for (const option of Object.keys(opts)) {
    if (option === 'url' && command !== 'logout') continue;
    if (!commandOptions[command].includes(option)) throw new Error(`--${option} is not supported by ${command}.`);
  }
  if (command === 'logout') {
    await rm(configPath(), { force: true });
    console.log(JSON.stringify({ local_credential_removed: true, server_revoked: false }));
    return;
  }
  const stored = command === 'login' ? null : await config();
  const origin = installationUrl(opts.url ?? process.env.KUBEPORT_URL ?? stored?.url);
  if (command === 'login') {
    process.stderr.write(`Open ${origin}/cli in your browser, sign in and create a connection token.\n`);
    const token = await readCredential();
    const result = await request(origin, token, 'GET', '/v1/me');
    if (!result.ok) { console.log(JSON.stringify(result.data)); process.exitCode = 1; return; }
    await saveConfig({ url: origin, token });
    console.log(JSON.stringify({ url: origin, user: result.data }));
    return;
  }
  const envToken = process.env.KUBEPORT_TOKEN;
  if (!envToken && stored?.url !== origin) throw new Error('Stored credential belongs to another installation. Run login for this URL.');
  const token = envToken ?? stored?.token;
  let method = 'GET', path, body, seconds;
  switch (command) {
    case 'whoami': path = '/v1/me'; break;
    case 'clusters': path = '/v1/clusters'; break;
    case 'templates':
      path = '/v1/templates' + (name ? `/${segment(name)}` : '') + (version ? `/versions/${segment(version)}` : ''); break;
    case 'releases': path = '/v1/releases' + (name ? `/${segment(name)}` : ''); break;
    case 'render':
      if (!/^[1-9][0-9]*$/.test(opts.version ?? '')) throw new Error('Pin the template version with --version N.');
      path = `/v1/templates/${segment(name)}/render?version=${opts.version}`;
      method = 'POST'; body = { values: await jsonFile(opts.file) };
      if (opts['release-id']) body.release_id = opts['release-id'];
      break;
    case 'deploy': path = '/v1/releases'; method = 'POST'; body = await jsonFile(opts.file); break;
    case 'update': path = `/v1/releases/${segment(name)}`; method = 'PUT'; body = await jsonFile(opts.file); break;
    case 'delete': path = `/v1/releases/${segment(name)}`; method = 'DELETE'; break;
    case 'logs':
      seconds = Number(opts.seconds ?? '10');
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('--seconds must be 1–60.');
      path = `/v1/releases/${segment(name)}/logs`; break;
    case 'api':
      method = name?.toUpperCase(); path = version;
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !path) throw new Error('api requires METHOD and /v1/path.');
      if (opts.file) body = await jsonFile(opts.file);
      if (method === 'GET' && body !== undefined) throw new Error('GET cannot have a request body.');
      break;
  }
  const result = await request(origin, token, method, path, body, seconds);
  console.log(JSON.stringify(result.data));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}
