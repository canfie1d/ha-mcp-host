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
const TAIL_LINES = 500;
// Terminal colour and cursor codes, which render as boxes on the app page.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export class ManagedApp {
  constructor(def, options, state, notify, secrets = {}) {
    this.def = def;
    this.options = options;
    this.state = state; // persisted per-app record, mutated in place
    this.notify = notify;
    this.repoDir = path.join(DATA, 'apps', def.name);
    this.setSecrets(secrets);
    this.child = null;
    this.tail = []; // "<ISO time> <line>", newest last
    this.lastFetch = null; // { ok, at, error } from the last sync with the upstream ref
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

  /** Add output to the log tail as one timestamped line per line of text. */
  record(text) {
    const at = new Date().toISOString();
    const lines = String(text).replace(ANSI, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return;
    this.tail.push(...lines.map((l) => `${at} ${l}`));
    if (this.tail.length > TAIL_LINES) this.tail = this.tail.slice(-TAIL_LINES);
  }

  /** A host message about this app: goes to the add-on log and to the app's own log. */
  note(msg) {
    log(this.name, msg);
    this.record(`[host] ${msg}`);
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
      this.note(`cloning ${this.def.repo} (${this.def.ref})`);
      const r = await run(`git ${auth}clone --branch ${this.def.ref} ${this.def.repo} ${this.repoDir}`);
      if (r.code !== 0) throw new Error(`clone failed: ${scrub(r.output).slice(-500)}`);
      return;
    }
    // Existing checkout: fast-forward to the upstream ref. A diverged checkout
    // (e.g. a locally kept auto-patch) is left alone rather than clobbered.
    const f = await run(`git ${auth}fetch origin ${this.def.ref}`, { cwd: this.repoDir });
    if (f.code !== 0) {
      const error = scrub(f.output).trim().slice(-300);
      this.lastFetch = { ok: false, at: new Date().toISOString(), error };
      this.note(`fetch failed, using existing checkout: ${error}`);
      return;
    }
    this.lastFetch = { ok: true, at: new Date().toISOString(), error: null };
    const before = await this.head();
    // Uncommitted edits to tracked files are always disposable here: builds regenerate committed
    // files (e.g. a TanStack routeTree.gen.ts) and an unkept Claude patch is reset. They would
    // block a merge, so with no local commits the checkout is moved to upstream outright.
    // Untracked and ignored files (build output, local data) are left alone.
    const ff = await run('git merge-base --is-ancestor HEAD FETCH_HEAD', { cwd: this.repoDir });
    const m = ff.code === 0
      ? await run('git reset --hard FETCH_HEAD', { cwd: this.repoDir })
      : { code: 1 };
    const after = await this.head();
    // Release tags give the app page a real version. Best effort, and only after the merge,
    // since this fetch replaces FETCH_HEAD.
    await run(`git ${auth}fetch --force origin "+refs/tags/*:refs/tags/*"`, { cwd: this.repoDir });
    if (m.code !== 0) this.note('checkout has local commits; not fast-forwarding');
    else if (after !== before) this.note(`updated ${before.slice(0, 8)} -> ${after.slice(0, 8)}`);
    else this.note(`already at ${after.slice(0, 8)}, the latest on ${this.def.ref}`);
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
    // Chunks can end mid-line; hold the partial line so each line gets one timestamp.
    const sinkFor = () => {
      let rest = '';
      const write = (d) => {
        out.write(d);
        const parts = (rest + String(d)).split('\n');
        rest = parts.pop();
        if (parts.length) this.record(parts.join('\n'));
      };
      write.flush = () => {
        if (rest) this.record(rest);
        rest = '';
      };
      return write;
    };
    const stdout = sinkFor();
    const stderr = sinkFor();
    const sink = (d) => {
      out.write(d);
      this.record(d);
    };
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    child.on('error', (err) => {
      sink(`\n[supervisor] failed to spawn: ${err.message}\n`);
      this.detail = `spawn failed: ${err.message}`;
      if (this.child === child) this.child = null;
    });
    child.on('exit', (code, sig) => {
      stdout.flush();
      stderr.flush();
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

  /**
   * What is checked out: commit, its subject and date, the nearest release tag (or the
   * package.json version when the repo has no tags), and how far it is from the upstream ref.
   */
  async version() {
    if (!fileExists(path.join(this.repoDir, '.git'))) return null;
    const opts = { cwd: this.repoDir };
    const r = await run('git log -1 --format=%H%x00%s%x00%cI', opts);
    if (r.code !== 0) return null;
    const [sha, subject, date] = r.output.trim().split('\0');
    const tag = await run('git describe --tags', opts);
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(path.join(this.repoDir, 'package.json'), 'utf8')).version || null;
    } catch {}
    // "<local-only commits>\t<upstream commits not yet pulled>", as of the last fetch.
    const lr = await run(`git rev-list --left-right --count HEAD...origin/${this.def.ref}`, opts);
    const [ahead, behind] = lr.code === 0 ? lr.output.trim().split(/\s+/).map(Number) : [null, null];
    return { sha, subject, date, tag: tag.code === 0 ? tag.output.trim() : null, pkg, ahead, behind };
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
      this.note(`heal: ${name}`);
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
          this.record(b.output.split('\n').slice(-60).join('\n'));
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
      this.note(`claude patch error: ${err.message}`);
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
