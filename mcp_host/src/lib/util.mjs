import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const DATA = process.env.DATA_DIR || '/data';
export const LOGS = path.join(DATA, 'logs');
mkdirSync(LOGS, { recursive: true });

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export const fileExists = existsSync;

export function log(scope, msg) {
  console.log(`${new Date().toISOString()} [${scope}] ${msg}`);
}

export function incident(entry) {
  appendFileSync(
    path.join(DATA, 'incidents.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  );
}

export function recentIncidents(limit = 50) {
  try {
    return readFileSync(path.join(DATA, 'incidents.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .slice(-limit)
      .map((l) => JSON.parse(l))
      .reverse();
  } catch {
    return [];
  }
}

/** Run a shell command to completion. Never throws; returns { code, output }. */
export function run(cmd, { cwd, env, timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env: { ...process.env, ...env } });
    let output = '';
    const cap = (d) => {
      output += d;
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: output + String(err) });
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
