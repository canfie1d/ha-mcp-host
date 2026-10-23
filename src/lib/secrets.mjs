// Per-app secrets, edited from each app's page and stored in /data (never in the add-on options).
import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA, log, readJson } from './util.mjs';

const FILE = path.join(DATA, 'secrets.json');
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE = 64 * 1024;

/**
 * Load the store. The first time it is missing, the old `secrets` list from the add-on
 * Configuration is imported once; after that the list in Configuration is ignored.
 */
export function loadSecrets(legacy = []) {
  if (existsSync(FILE)) return readJson(FILE, {});
  const store = {};
  for (const s of legacy) {
    if (s?.app && s?.name && typeof s.value === 'string') (store[s.app] ||= {})[s.name] = s.value;
  }
  saveSecrets(store);
  if (legacy.length) log('host', `imported ${legacy.length} secret(s) from the add-on Configuration into ${FILE}`);
  return store;
}

export function saveSecrets(store) {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}

/** Validate a { set: {NAME: value}, remove: [NAME] } edit. Returns a list of problems. */
export function validateSecretEdit(body) {
  const errors = [];
  const set = body?.set ?? {};
  const remove = body?.remove ?? [];
  if (typeof set !== 'object' || Array.isArray(set)) errors.push('"set" must be an object');
  else for (const [k, v] of Object.entries(set)) {
    if (!SECRET_NAME_RE.test(k)) errors.push(`secret name "${k}" is invalid`);
    if (typeof v !== 'string' || v === '') errors.push(`secret "${k}" needs a non-empty value`);
    else if (v.length > MAX_VALUE) errors.push(`secret "${k}" is too long`);
  }
  if (!Array.isArray(remove) || remove.some((k) => typeof k !== 'string')) errors.push('"remove" must be an array of names');
  return errors;
}
