import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA, LOGS, fileExists, incident, log, run, sleep } from './util.mjs';
import { checkApp, checkWarning } from './health.mjs';
import { patchWithClaude } from './claude.mjs';

const FAILS_BEFORE_HEAL = 3;
const GIVE_UP_COOLDOWN_MS = 30 * 60_000;
const STARTUP_WAIT_MS = 90_000;
const WARN_RENOTIFY_MS = 12 * 60 * 60_000;

export class ManagedApp {
  constructor(def, options, state, notify, secrets = {}) {
    this.def = def;
    this.options = options;
    this.state = state; // persisted per-app record, mutated in place
    this.notify = notify;
    this.repoDir = path.join(DATA, 'apps', def.name);
    this.setSecrets(secrets);
    this.child = null;
    this.tail = [];
    this.fails = 0;
    this.goodStreak = 0;
    this.status = 'starting';
    this.detail = '';
    this.healing = false;
    this.coolUntil = 0;
    this.warning = '';
    this.warnedAt = 0;
    this.retired = false; // set when removed/replaced via the apps editor; must never start again
    this.busy = ''; // name of a manual action (restart, rebuild) in progress; pauses health ticks
  }

  setSecrets(secrets) {
    this.secrets = { ...secrets };
    this.missing = (this.def.requiredSecrets || []).filter((n) => !this.secrets[n]);
  }

  get name() {
    return this.def.name;
  }

  // ---- lifecycle -------------------------------------------------------

  env() {
    const repo = this.repoDir;
    const fromDef = Object.fromEntries(
      Object.entries(this.def.env || {}).map(([k, v]) => [k, String(v).replaceAll('{{repo}}', repo)]),
    );
    return { NODE_ENV: 'production', ...fromDef, ...this.secrets };
  }

  async sync() {
    const token = this.options.github_token;
    const auth = token && /^https:\/\/github\.com\//.test(this.def.repo)
      ? `-c http.extraheader="AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}" `
      : '';
    const scrub = (t) => (token ? t.replaceAll(token, '***') : t);
    if (!fileExists(path.join(this.repoDir, '.git'))) {
      const r = await run(`git ${auth}clone --branch ${this.def.ref} ${this.def.repo} ${this.repoDir}`);
      if (r.code !== 0) throw new Error(`clone failed: ${scrub(r.output).slice(-500)}`);
      return;
    }
    // Existing checkout: fast-forward to the upstream ref. A diverged checkout
    // (e.g. a locally kept auto-patch) is left alone rather than clobbered.
    const f = await run(`git ${auth}fetch origin ${this.def.ref}`, { cwd: this.repoDir });
    if (f.code !== 0) {
      log(this.name, `fetch failed, using existing checkout: ${scrub(f.output).slice(-200)}`);
      return;
    }
    const before = await this.head();
    const m = await run('git merge --ff-only FETCH_HEAD', { cwd: this.repoDir });
    const after = await this.head();
    if (m.code !== 0) log(this.name, 'checkout has local commits; not fast-forwarding');
    else if (after !== before) log(this.name, `updated ${before.slice(0, 8)} -> ${after.slice(0, 8)}`);
  }

  /** Install and build. Install/build run with devDependencies available. */
  async build({ clean = false } = {}) {
    const buildEnv = { NODE_ENV: 'development', CI: '1' };
    if (clean) await run('rm -rf node_modules', { cwd: this.repoDir });
    const install = await run(this.def.install, { cwd: this.repoDir, env: buildEnv });
    if (install.code !== 0) return { ok: false, output: `install failed:\n${install.output}` };
    const build = await run(this.def.build, { cwd: this.repoDir, env: { ...buildEnv, ...this.env(), NODE_ENV: 'production' } });
    if (build.code !== 0) return { ok: false, output: `build failed:\n${build.output}` };
    return { ok: true, output: build.output };
  }

  start() {
    this.stop();
    if (this.retired) return;
    if (!fileExists(this.repoDir)) {
      this.detail = 'checkout missing; needs clone and build';
      this.needsRebuild = true;
      return;
    }
    const out = createWriteStream(path.join(LOGS, `${this.name}.log`), { flags: 'a' });
    const child = spawn('sh', ['-c', `exec ${this.def.start}`], {
      cwd: this.repoDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME || '/root', ...this.env() },
    });
    const sink = (d) => {
      out.write(d);
      this.tail.push(...String(d).split('\n'));
      if (this.tail.length > 300) this.tail = this.tail.slice(-300);
    };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    child.on('error', (err) => {
      sink(`\n[supervisor] failed to spawn: ${err.message}\n`);
      this.detail = `spawn failed: ${err.message}`;
      if (this.child === child) this.child = null;
    });
    child.on('exit', (code, sig) => {
      sink(`\n[supervisor] process exited code=${code} signal=${sig}\n`);
      if (this.child === child) this.child = null;
    });
    this.child = child;
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 8000).unref();
  }

  async head() {
    return (await run('git rev-parse HEAD', { cwd: this.repoDir })).output.trim();
  }

  /** What is checked out: commit, its subject and date, and the package.json version if any. */
  async version() {
    if (!fileExists(path.join(this.repoDir, '.git'))) return null;
    const r = await run('git log -1 --format=%H%x00%s%x00%cI', { cwd: this.repoDir });
    if (r.code !== 0) return null;
    const [sha, subject, date] = r.output.trim().split('\0');
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(path.join(this.repoDir, 'package.json'), 'utf8')).version || null;
    } catch {}
    return { sha, subject, date, pkg };
  }

  // ---- health ----------------------------------------------------------

  async check() {
    if (!this.child) return { ok: false, detail: 'process not running' };
    return checkApp(this.def, this.secrets);
  }

  async waitHealthy(timeoutMs = STARTUP_WAIT_MS) {
    const until = Date.now() + timeoutMs;
    let last = { ok: false, detail: 'no check yet' };
    while (Date.now() < until) {
      await sleep(3000);
      last = await this.check();
      if (last.ok) return last;
      if (!this.child) return last;
    }
    return last;
  }

  /** Called every interval by the main loop. */
  async tick() {
    if (this.retired || this.healing || this.busy || this.missing.length) return;
    if (Date.now() < this.coolUntil) return;

    const r = await this.check();
    this.detail = r.detail;
    if (r.ok) {
      this.fails = 0;
      this.goodStreak++;
      if (this.status !== 'healthy') this.status = 'healthy';
      if (this.goodStreak === 2) await this.markGood();
      await this.checkWarn(r.detail);
      return;
    }

    this.goodStreak = 0;
    this.fails++;
    this.status = 'unhealthy';
    if (this.fails >= FAILS_BEFORE_HEAL) await this.heal(r.detail);
  }

  /** Notify-only condition: surfaced and announced, never healed. */
  async checkWarn(okDetail) {
    const warn = await checkWarning(this.def);
    this.warning = warn || '';
    if (!warn) {
      this.warnedAt = 0;
      return;
    }
    this.detail = `${okDetail}; NEEDS ATTENTION: ${warn}`;
    if (Date.now() - this.warnedAt >= WARN_RENOTIFY_MS) {
      this.warnedAt = Date.now();
      await this.notify('MCP needs attention', `${this.name}: ${warn}`);
    }
  }

  async markGood() {
    const sha = await this.head();
    if (sha && sha !== this.state.lastGood) {
      this.state.lastGood = sha;
      this.state.dirty = true;
    }
  }

  // ---- healing ladder --------------------------------------------------

  async heal(failure) {
    this.healing = true;
    this.status = 'healing';
    const steps = [];
    const outcome = async (name, fn) => {
      log(this.name, `heal: ${name}`);
      steps.push(name);
      const ok = await fn();
      if (ok) {
        this.fails = 0;
        this.status = 'healthy';
        incident({ app: this.name, failure, resolvedBy: name, steps });
        await this.notify('MCP healed', `${this.name} recovered via: ${name}\nCause: ${failure}`);
      }
      return ok;
    };

    try {
      const restart = () => {
        this.start();
        return this.waitHealthy().then((r) => r.ok);
      };
      const rebuild = async (clean) => {
        this.stop();
        const b = await this.build({ clean });
        if (!b.ok) {
          this.tail.push(...b.output.split('\n').slice(-60));
          return false;
        }
        return restart();
      };

      if (!fileExists(path.join(this.repoDir, '.git'))) {
        const ok = await outcome('clone + build', async () => {
          await this.sync();
          return rebuild(true);
        });
        if (ok) return;
      }
      if (await outcome('restart', restart)) return;
      if (await outcome('clean reinstall + rebuild', () => rebuild(true))) return;

      if (this.state.lastGood && this.state.lastGood !== (await this.head())) {
        const ok = await outcome(`rollback to ${this.state.lastGood.slice(0, 8)}`, async () => {
          await run(`git reset --hard ${this.state.lastGood}`, { cwd: this.repoDir });
          return rebuild(false);
        });
        if (ok) return;
      }

      if (await this.tryClaude(failure, steps)) return;

      this.status = 'failed';
      this.coolUntil = Date.now() + GIVE_UP_COOLDOWN_MS;
      incident({ app: this.name, failure, resolvedBy: null, steps });
      await this.notify('MCP DOWN', `${this.name} could not be recovered automatically.\nLast error: ${failure}\nTried: ${steps.join(', ')}`);
    } finally {
      this.state.dirty = true;
      this.healing = false;
    }
  }

  patchBudgetLeft() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.patchDay !== today) {
      this.state.patchDay = today;
      this.state.patchCount = 0;
    }
    return this.options.max_patches_per_day - this.state.patchCount;
  }

  async tryClaude(failure, steps) {
    if (!this.options.auto_patch || !this.options.anthropic_api_key) return false;
    if (this.patchBudgetLeft() <= 0) {
      steps.push('claude patch skipped (daily limit)');
      return false;
    }
    this.state.patchCount++;
    steps.push('claude patch');
    const before = await this.head();

    try {
      const gitLog = (await run('git log --oneline -n 5', { cwd: this.repoDir })).output;
      let lastBuildOutput = '';
      const rebuild = async () => {
        this.stop();
        const b = await this.build();
        lastBuildOutput = b.output;
        if (!b.ok) return { ok: false, detail: 'build failed', buildOutput: b.output };
        this.start();
        const h = await this.waitHealthy();
        return { ok: h.ok, detail: h.detail, buildOutput: b.output };
      };

      const result = await patchWithClaude({
        options: this.options,
        app: this.def,
        repoDir: this.repoDir,
        failure,
        logs: this.tail.slice(-120).join('\n'),
        gitLog,
        rebuild,
      });

      if (result.fixed) {
        await run(
          `git add -A && git -c user.name="mcp-host" -c user.email="mcp-host@local" commit -m "auto-fix: ${failure.replace(/["$`\\]/g, '').slice(0, 100)}"`,
          { cwd: this.repoDir },
        );
        const branch = await this.pushBranch();
        this.fails = 0;
        this.status = 'healthy';
        incident({ app: this.name, failure, resolvedBy: 'claude patch', summary: result.summary, branch });
        await this.notify(
          'MCP patched by Claude',
          `${this.name} fixed.\n${result.summary.slice(0, 400)}${branch ? `\nBranch: ${branch}` : ''}`,
        );
        return true;
      }

      // Not fixed: undo any edits and put the last working code back.
      await run(`git reset --hard ${before} && git clean -fd`, { cwd: this.repoDir });
      incident({ app: this.name, failure, claudeSummary: result.summary, outcome: 'not fixed' });
      return false;
    } catch (err) {
      log(this.name, `claude patch error: ${err.message}`);
      await run(`git reset --hard ${before} && git clean -fd`, { cwd: this.repoDir });
      return false;
    }
  }

  /** Publish the patch as a branch so upstream can adopt it. */
  async pushBranch() {
    const token = this.options.github_token;
    const m = /github\.com[/:](.+?)(\.git)?$/.exec(this.def.repo);
    if (!token || !m) return null;
    const branch = `auto-fix/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const r = await run(
      `git push "https://x-access-token:$GH_TOKEN@github.com/${m[1]}.git" HEAD:refs/heads/${branch}`,
      { cwd: this.repoDir, env: { GH_TOKEN: token } },
    );
    return r.code === 0 ? branch : null;
  }

  snapshot() {
    return {
      name: this.name,
      status: this.missing.length ? 'needs-secrets' : this.busy ? 'starting' : this.status,
      detail: this.missing.length ? `missing secrets: ${this.missing.join(', ')}` : this.detail,
      port: this.def.port,
      warning: this.warning || null,
      lastGood: this.state.lastGood?.slice(0, 8) || null,
      patchesToday: this.state.patchDay === new Date().toISOString().slice(0, 10) ? this.state.patchCount : 0,
      logTail: this.tail.slice(-40),
    };
  }
}
