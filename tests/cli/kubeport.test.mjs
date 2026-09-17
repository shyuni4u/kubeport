import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationUrl, apiUrl, request } from '../../skills/kubeport/scripts/kubeport.mjs';

const token = 'kbp_cli_' + 'x'.repeat(80);
const script = fileURLToPath(new URL('../../skills/kubeport/scripts/kubeport.mjs', import.meta.url));
async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}

function run(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const name of ['KUBEPORT_TOKEN', 'KUBEPORT_URL', 'KUBEPORT_CONFIG']) delete childEnv[name];
    const child = spawn(process.execPath, [script, ...args], { env: { ...childEnv, ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('requires an explicit installation and HTTPS except loopback', () => {
  assert.equal(installationUrl('https://team.example/'), 'https://team.example');
  assert.equal(installationUrl('http://localhost:3000'), 'http://localhost:3000');
  for (const url of [undefined, 'http://team.example', 'https://user:secret@team.example', 'https://team.example/path', 'https://team.example/?target=other']) {
    assert.throws(() => installationUrl(url));
  }
});

test('rejects external URLs, traversal, encoded separators and fragments', () => {
  const origin = 'https://team.example';
  assert.equal(apiUrl(origin, '/v1/releases?limit=20'), origin + '/api/cli/v1/releases?limit=20');
  for (const path of ['https://other.example', '//other.example', '/v1/../healthz', '/v1/%2e%2e/healthz', '/v1/a%2fb', '/v1/a%252fb', '/v1/a#b', '/v1//me', '/v1/a\\b']) {
    assert.throws(() => apiUrl(origin, path));
  }
});

test('never follows redirects with a credential', async t => {
  const paths = [];
  const origin = await server(t, (req, res) => { paths.push(req.url); res.writeHead(302, { location: '/stolen' }); res.end(); });
  await assert.rejects(request(origin, token, 'GET', '/v1/me'), /redirected/);
  assert.deepEqual(paths, ['/api/cli/v1/me']);
});

test('preserves API errors without retrying writes', async t => {
  let calls = 0;
  const origin = await server(t, (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ title: 'forbidden', request_id: 'trace' }));
  });
  const result = await request(origin, token, 'POST', '/v1/releases', { name: 'test' });
  assert.equal(result.ok, false);
  assert.equal(result.data.request_id, 'trace');
  assert.equal(calls, 1);
});

test('SSE errors are failures even with HTTP 200 and retain cursor IDs', async t => {
  const origin = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: log\nid: cursor\ndata: {"line":"hello"}\n\nevent: error\ndata: {"title":"forbidden"}\n\n');
  });
  const result = await request(origin, token, 'GET', '/v1/releases/id/logs', undefined, 1);
  assert.equal(result.ok, false);
  assert.equal(result.data.events[0].id, 'cursor');
  assert.equal(result.data.events[1].data.title, 'forbidden');
});

test('bounds a live log stream instead of hanging indefinitely', async t => {
  const origin = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: log\ndata: {"line":"hello"}\n\n');
  });
  const result = await request(origin, token, 'GET', '/v1/releases/id/logs', undefined, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.events[0].data.line, 'hello');
});

test('login validates identity, saves privately, refuses target switching, and logout removes only local state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kubeport-cli-test-'));
  const filename = join(directory, 'credentials.json');
  t.after(async () => { await rm(filename, { force: true }); await rmdir(directory); });
  let calls = 0;
  const origin = await server(t, (req, res) => {
    calls++;
    assert.equal(req.url, '/api/cli/v1/me');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"email":"person@example.org"}');
  });
  const env = { KUBEPORT_CONFIG: filename };
  const login = await run(['login', '--url', origin], env, token + '\n');
  assert.equal(login.code, 0, login.stderr);
  assert.ok(!login.stdout.includes(token) && !login.stderr.includes(token));
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).url, origin);
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const me = await run(['whoami'], env);
  assert.equal(me.code, 0, me.stderr);
  assert.equal(JSON.parse(me.stdout).email, 'person@example.org');
  const other = await run(['whoami', '--url', 'https://another.example'], env);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /another installation/);
  assert.equal(calls, 2);
  const logout = await run(['logout'], env);
  assert.equal(logout.code, 0);
  assert.equal(JSON.parse(logout.stdout).server_revoked, false);
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
});

test('rejects irrelevant flags instead of silently changing operation semantics', async () => {
  const result = await run(['delete', 'release-id', '--version', '3'], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not supported/);
});
