import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, log, readJson, recentIncidents, sleep, writeJson } from './lib/util.mjs';
import { ManagedApp } from './lib/app.mjs';
import { notify as sendNotify } from './lib/notify.mjs';
import { planChanges, validateAppsConfig } from './lib/appsconfig.mjs';
import { appPage, editorPage, statusPage } from './lib/editor.mjs';
import { loadSecrets, saveSecrets, validateSecretEdit } from './lib/secrets.mjs';

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
// Dev override: load via `node --env-file=.env` so the key stays scoped to this project.
if (process.env.ANTHROPIC_API_KEY) options.anthropic_api_key = process.env.ANTHROPIC_API_KEY;
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
const secrets = loadSecrets(options.secrets);
const makeApp = (d) => new ManagedApp(d, options, (state[d.name] ||= {}), notify, secrets[d.name]);
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

// Link to this add-on's Settings > Apps > Configuration page. The slug carries a repository
// hash, so it is read from the Supervisor instead of hard-coded. No link is shown if the lookup fails.
let settingsUrl = null;
async function resolveSettingsUrl() {
  if (settingsUrl || !options.supervisorToken) return settingsUrl;
  try {
    const r = await fetch('http://supervisor/addons/self/info', {
      headers: { authorization: `Bearer ${options.supervisorToken}` },
      signal: AbortSignal.timeout(3000),
    });
    const slug = r.ok ? (await r.json())?.data?.slug : null;
    if (slug) settingsUrl = `/config/app/${slug}/config`;
  } catch {}
  return settingsUrl;
}

const snapshots = () => apps.map((a) => ({ ...a.snapshot(), description: a.def.description || '' }));

// Everything the shared page layout needs: the app list for the side nav and the link targets.
async function layout(req, current) {
  // HA ingress sends the panel's path prefix; pages use it as <base> so nested routes resolve.
  const prefix = String(req.headers['x-ingress-path'] || '');
  return {
    base: /^\/[\w\-/]*$/.test(prefix) ? `${prefix.replace(/\/+$/, '')}/` : '/',
    settingsUrl: await resolveSettingsUrl(),
    nav: snapshots().map(({ name, status }) => ({ name, status })),
    current,
    // Secrets set in the old add-on Configuration list are no longer read after the one-time import.
    legacySecrets: options.secrets.length,
  };
}

async function appDetail(app) {
  const s = app.snapshot();
  const d = app.def;
  return {
    ...s,
    description: d.description || '',
    busy: app.busy,
    logTail: app.tail.slice(-300),
    version: await app.version(),
    repo: d.repo,
    ref: d.ref,
    mcpPath: d.mcp?.path || null,
    healthPath: d.health.path,
    secrets: {
      required: d.requiredSecrets || [],
      set: Object.keys(app.secrets).sort(),
    },
    incidents: recentIncidents(500).filter((i) => i.app === app.name).slice(0, 20),
  };
}

/** Run one manual action per app at a time; the health loop sits out while it runs. */
function runAction(app, label, fn) {
  if (app.busy || app.healing) return false;
  app.busy = label;
  log(app.name, `manual ${label}`);
  (async () => {
    try {
      await fn();
    } catch (err) {
      app.status = 'unhealthy';
      app.detail = err.message;
    } finally {
      app.busy = '';
    }
  })();
  return true;
}

async function restart(app) {
  if (app.missing.length) return;
  app.start();
  const h = await app.waitHealthy();
  app.status = h.ok ? 'healthy' : 'unhealthy';
  app.detail = h.detail;
}

function updateSecrets(app, body) {
  const errors = validateSecretEdit(body);
  if (errors.length) return { status: 400, body: { ok: false, errors } };
  const next = { ...(secrets[app.name] || {}), ...(body.set || {}) };
  for (const k of body.remove || []) delete next[k];
  secrets[app.name] = next;
  saveSecrets(secrets);
  const wasWaiting = app.missing.length > 0;
  app.setSecrets(next);
  // New values only reach the process on start. An app that was waiting on secrets has never
  // been built, so it gets the full bootstrap; a running one just restarts.
  const wanted = app.missing.length ? null : wasWaiting ? 'build' : 'restart';
  // While healing or another action runs, the values still apply on that run's next start.
  const action = wanted && runAction(app, wanted, () => (wanted === 'build' ? bootstrap(app) : restart(app))) ? wanted : null;
  return { status: 200, body: { ok: true, set: Object.keys(next).sort(), missing: app.missing, action, deferred: !!wanted && !action } };
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const sendJson = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));
// State-changing requests must be JSON, which a cross-site form cannot send.
const isJson = (req) => String(req.headers['content-type'] || '').startsWith('application/json');
const ACTIONS = { restart: (app) => restart(app), rebuild: (app) => bootstrap(app) };

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
    const api = /\/api\/app\/([^/]+)(?:\/(secrets|restart|rebuild))?$/.exec(route);
    if (api) {
      const app = apps.find((a) => a.name === decodeURIComponent(api[1]));
      if (!app) return sendJson(res, 404, { ok: false, errors: ['no such app'] });
      const op = api[2];
      if (!op && req.method === 'GET') return sendJson(res, 200, await appDetail(app));
      if (!op || req.method !== (op === 'secrets' ? 'PUT' : 'POST')) {
        return sendJson(res, 405, { ok: false, errors: ['method not allowed'] });
      }
      if (!isJson(req)) return sendJson(res, 415, { ok: false, errors: ['content-type must be application/json'] });
      if (op === 'secrets') {
        const out = updateSecrets(app, JSON.parse((await readBody(req)) || '{}'));
        return sendJson(res, out.status, out.body);
      }
      if (app.missing.length) return sendJson(res, 409, { ok: false, errors: [`missing secrets: ${app.missing.join(', ')}`] });
      if (!runAction(app, op, () => ACTIONS[op](app))) return sendJson(res, 409, { ok: false, errors: [`busy: ${app.busy || 'healing'}`] });
      return sendJson(res, 202, { ok: true });
    }
    const page = /\/app\/([^/]+)$/.exec(route);
    if (page) {
      const app = apps.find((a) => a.name === decodeURIComponent(page[1]));
      if (app) return send(res, 200, 'text/html', appPage(await appDetail(app), await layout(req, app.name)));
      return send(res, 404, 'text/html', statusPage(snapshots(), recentIncidents(15), await layout(req, null), 'No app by that name.'));
    }
    if (route.endsWith('/apps')) return send(res, 200, 'text/html', editorPage(await layout(req, 'apps')));
    return send(res, 200, 'text/html', statusPage(snapshots(), recentIncidents(15), await layout(req, '')));
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
