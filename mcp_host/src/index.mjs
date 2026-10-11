import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, log, readJson, recentIncidents, sleep, writeJson } from './lib/util.mjs';
import { ManagedApp } from './lib/app.mjs';
import { notify as sendNotify } from './lib/notify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK_INTERVAL_MS = Number(process.env.MCPHOST_INTERVAL_MS) || 30_000;
const STATUS_PORT = Number(process.env.MCPHOST_STATUS_PORT) || 8100;

const options = {
  anthropic_api_key: '',
  claude_model: 'claude-sonnet-5-5',
  notify_service: '',
  auto_patch: true,
  max_patches_per_day: 3,
  github_token: '',
  secrets: [],
  ...readJson(path.join(DATA, 'options.json'), {}),
};
options.supervisorToken = process.env.SUPERVISOR_TOKEN;

// Children must not inherit the supervisor's own credentials or build mode.
delete process.env.SUPERVISOR_TOKEN;
delete process.env.NODE_ENV;

const notify = (title, msg) => sendNotify(options, title, msg);
// App definitions live in the add-on's private config dir, never in the repo.
const APPS_FILE = process.env.MCPHOST_APPS_FILE || '/config/apps.json';
if (!existsSync(APPS_FILE)) {
  mkdirSync(path.dirname(APPS_FILE), { recursive: true });
  writeFileSync(APPS_FILE, JSON.stringify({ apps: [] }, null, 2) + '\n');
  log('host', `no app definitions found; created empty ${APPS_FILE}`);
}
const defs = readJson(APPS_FILE, { apps: [] }).apps;
const stateFile = path.join(DATA, 'state.json');
const state = readJson(stateFile, {});
const apps = defs.map((d) => new ManagedApp(d, options, (state[d.name] ||= {}), notify));

async function bootstrap(app) {
  if (app.missing.length) {
    app.status = 'needs-secrets';
    log(app.name, `not started, missing secrets: ${app.missing.join(', ')}`);
    return;
  }
  try {
    await app.sync();
    const b = await app.build();
    if (!b.ok) {
      app.tail.push(...b.output.split('\n').slice(-60));
      app.status = 'unhealthy';
      app.fails = 3; // go straight to the healing ladder on the first tick
      return;
    }
    app.start();
    const h = await app.waitHealthy();
    app.status = h.ok ? 'healthy' : 'unhealthy';
    app.detail = h.detail;
  } catch (err) {
    app.status = 'unhealthy';
    app.detail = err.message;
    app.fails = 3;
  }
}

function page() {
  const rows = apps
    .map((a) => a.snapshot())
    .map(
      (s) =>
        `<tr><td>${s.name}</td><td class="${s.status}">${s.status}</td><td>${s.port}</td><td>${s.lastGood ?? '-'}</td><td>${s.patchesToday}</td><td>${s.detail}</td></tr>`,
    )
    .join('');
  const inc = recentIncidents(15)
    .map((i) => `<li><b>${i.at}</b> ${i.app}: ${i.resolvedBy ?? 'UNRESOLVED'} — ${i.failure ?? ''}</li>`)
    .join('');
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>MCP Host</title>
<style>body{font:15px system-ui;margin:16px;max-width:900px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #8884;text-align:left}
.healthy{color:#1a7f37}.unhealthy,.failed{color:#cf222e}.healing,.starting,.needs-secrets{color:#9a6700}</style>
<h2>MCP Host</h2>
<table><tr><th>App</th><th>Status</th><th>Port</th><th>Last good</th><th>Patches today</th><th>Detail</th></tr>${rows}</table>
<h3>Recent incidents</h3><ul>${inc || '<li>None</li>'}</ul>`;
}

createServer((req, res) => {
  if (req.url?.endsWith('/status.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ apps: apps.map((a) => a.snapshot()), incidents: recentIncidents(50) }));
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page());
  }
}).listen(STATUS_PORT, '0.0.0.0');

async function main() {
  log('supervisor', `managing ${apps.length} app(s)`);
  await Promise.all(apps.map(bootstrap));

  const unhealthy = apps.filter((a) => a.status !== 'healthy' && a.status !== 'needs-secrets');
  if (unhealthy.length) log('supervisor', `starting unhealthy: ${unhealthy.map((a) => a.name).join(', ')}`);

  for (;;) {
    await Promise.all(apps.map((a) => a.tick().catch((err) => log(a.name, `tick error: ${err.message}`))));
    if (apps.some((a) => a.state.dirty)) {
      for (const a of apps) delete a.state.dirty;
      writeJson(stateFile, state);
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    apps.forEach((a) => a.stop());
    setTimeout(() => process.exit(0), 1500);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
