import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, log, readJson, recentIncidents, sleep, writeJson } from './lib/util.mjs';
import { ManagedApp } from './lib/app.mjs';
import { notify as sendNotify } from './lib/notify.mjs';
import { planChanges, validateAppsConfig } from './lib/appsconfig.mjs';
import { editorPage, statusPage } from './lib/editor.mjs';

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

// One app's failure must never take the supervisor (and every other app) down.
process.on('uncaughtException', (err) => log('supervisor', `uncaught: ${err.stack || err}`));
process.on('unhandledRejection', (err) => log('supervisor', `unhandled rejection: ${err?.stack || err}`));

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
const makeApp = (d) => new ManagedApp(d, options, (state[d.name] ||= {}), notify);
let apps = defs.map(makeApp);

/**
 * Apply a new, already-validated list of definitions to the running set without a restart.
 * Unchanged apps keep running; changed apps are stopped and rebuilt; removed apps are stopped.
 * Builds happen in the background so the caller gets the plan immediately.
 */
function applyDefs(newDefs) {
  const plan = planChanges(apps.map((a) => a.def), newDefs);
  const existing = new Map(apps.map((a) => [a.name, a]));
  const fresh = [];
  for (const name of [...plan.removed, ...plan.changed]) {
    const old = existing.get(name);
    const newDef = newDefs.find((d) => d.name === name);
    old.retired = true;
    old.stop();
    // Last-known-good commit is meaningless against a different repo.
    if (!newDef || newDef.repo !== old.def.repo) delete state[name];
    if (!newDef) existing.delete(name);
  }
  apps = newDefs.map((d) => {
    if (plan.unchanged.includes(d.name)) return existing.get(d.name);
    const app = makeApp(d);
    fresh.push(app);
    return app;
  });
  writeJson(stateFile, state);
  log('supervisor', `apps reloaded: +${plan.added.length} ~${plan.changed.length} -${plan.removed.length}`);
  (async () => {
    if (plan.changed.length) await sleep(3000); // let old processes release their ports
    await Promise.all(fresh.map(bootstrap));
  })().catch((err) => log('supervisor', `reload bootstrap error: ${err.message}`));
  return plan;
}

function persistApps(cfg) {
  const text = JSON.stringify(cfg, null, 2) + '\n';
  if (existsSync(APPS_FILE)) copyFileSync(APPS_FILE, `${APPS_FILE}.bak`);
  const tmp = `${APPS_FILE}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, APPS_FILE);
  return text;
}

// Saves are serialized so two quick clicks cannot interleave file and process changes.
let saving = Promise.resolve();
function saveApps(text, dryRun) {
  const job = saving.then(() => {
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch (err) {
      return { status: 400, body: { ok: false, errors: [`Invalid JSON: ${err.message}`] } };
    }
    const errors = validateAppsConfig(cfg);
    if (errors.length) return { status: 400, body: { ok: false, errors } };
    if (dryRun) return { status: 200, body: { ok: true, plan: planChanges(apps.map((a) => a.def), cfg.apps) } };
    const saved = persistApps(cfg);
    return { status: 200, body: { ok: true, text: saved, plan: applyDefs(cfg.apps) } };
  });
  saving = job.catch(() => {});
  return job;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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
  const snaps = apps.map((a) => ({ ...a.snapshot(), description: a.def.description || '' }));
  return statusPage(snaps, recentIncidents(15));
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const sendJson = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));

createServer(async (req, res) => {
  try {
    const route = new URL(req.url || '/', 'http://x').pathname.replace(/\/+$/, '');
    const query = new URL(req.url || '/', 'http://x').searchParams;
    if (route.endsWith('/status.json')) {
      return sendJson(res, 200, { apps: apps.map((a) => a.snapshot()), incidents: recentIncidents(50) });
    }
    if (route.endsWith('/api/apps')) {
      if (req.method === 'GET') {
        const text = existsSync(APPS_FILE) ? readFileSync(APPS_FILE, 'utf8') : '{ "apps": [] }\n';
        return sendJson(res, 200, { text });
      }
      if (req.method === 'PUT') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, errors: ['content-type must be application/json'] });
        }
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.text !== 'string') return sendJson(res, 400, { ok: false, errors: ['"text" is required'] });
        const out = await saveApps(body.text, query.get('dryRun') === '1');
        return sendJson(res, out.status, out.body);
      }
      return sendJson(res, 405, { ok: false, errors: ['method not allowed'] });
    }
    if (route.endsWith('/apps')) return send(res, 200, 'text/html', editorPage());
    return send(res, 200, 'text/html', page());
  } catch (err) {
    log('supervisor', `http error: ${err.stack || err}`);
    sendJson(res, 500, { ok: false, errors: [err.message] });
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
