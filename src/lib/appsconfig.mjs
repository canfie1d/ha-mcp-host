// Validation and diffing for apps.json, shared by the supervisor and the editor UI.

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const APP_KEYS = new Set([
  'name', 'description', 'repo', 'ref', 'install', 'build', 'start', 'port', 'env',
  'requiredSecrets', 'health', 'mcp',
]);
const HEALTH_KEYS = new Set(['path', 'warnPath']);
const MCP_KEYS = new Set(['path', 'unauthenticatedStatusOk', 'authBearerSecret']);
const RESERVED_PORTS = new Set([8100]); // status UI

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) errors.push(`${where}: unknown key "${k}"`);
}

/** Returns a list of human-readable problems; empty means valid. */
export function validateAppsConfig(cfg) {
  const errors = [];
  if (!isObj(cfg)) return ['top level must be an object like {"apps": [...]}'];
  unknownKeys(cfg, new Set(['apps']), 'top level', errors);
  if (!Array.isArray(cfg.apps)) return [...errors, '"apps" must be an array'];

  const names = new Set();
  const ports = new Map();

  cfg.apps.forEach((a, i) => {
    const where = isObj(a) && isStr(a.name) ? `app "${a.name}"` : `apps[${i}]`;
    if (!isObj(a)) return errors.push(`${where}: must be an object`);
    unknownKeys(a, APP_KEYS, where, errors);

    if (!isStr(a.name) || !NAME_RE.test(a.name)) {
      errors.push(`${where}: "name" must be lowercase letters, digits, "-" or "_" (max 63 chars)`);
    } else if (names.has(a.name)) {
      errors.push(`${where}: duplicate name`);
    } else names.add(a.name);

    for (const k of ['repo', 'ref', 'install', 'build', 'start']) {
      if (!isStr(a[k])) errors.push(`${where}: "${k}" is required (non-empty string)`);
    }
    if (isStr(a.repo) && !/^(https:\/\/|git@)/.test(a.repo)) errors.push(`${where}: "repo" must be an https:// or git@ URL`);
    if (isStr(a.ref) && /[\s;&|`$'"\\]/.test(a.ref)) errors.push(`${where}: "ref" contains characters not allowed in a git ref`);
    if (isStr(a.repo) && /[\s;&|`$'"\\<>]/.test(a.repo)) errors.push(`${where}: "repo" contains unsafe characters`);
    if (a.description !== undefined && typeof a.description !== 'string') errors.push(`${where}: "description" must be a string`);

    if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535) {
      errors.push(`${where}: "port" must be an integer between 1024 and 65535`);
    } else if (RESERVED_PORTS.has(a.port)) {
      errors.push(`${where}: port ${a.port} is reserved for the status UI`);
    } else if (ports.has(a.port)) {
      errors.push(`${where}: port ${a.port} is already used by "${ports.get(a.port)}"`);
    } else ports.set(a.port, a.name);

    if (a.env !== undefined) {
      if (!isObj(a.env)) errors.push(`${where}: "env" must be an object`);
      else for (const [k, v] of Object.entries(a.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) errors.push(`${where}: env name "${k}" is invalid`);
        if (!['string', 'number', 'boolean'].includes(typeof v)) errors.push(`${where}: env "${k}" must be a string, number or boolean`);
      }
    }

    if (a.requiredSecrets !== undefined) {
      if (!Array.isArray(a.requiredSecrets) || a.requiredSecrets.some((s) => !isStr(s))) {
        errors.push(`${where}: "requiredSecrets" must be an array of strings`);
      }
    }

    if (!isObj(a.health)) {
      errors.push(`${where}: "health" is required and must be an object with a "path"`);
    } else {
      unknownKeys(a.health, HEALTH_KEYS, `${where}.health`, errors);
      if (!isStr(a.health.path) || !a.health.path.startsWith('/')) errors.push(`${where}: health.path must start with "/"`);
      if (a.health.warnPath !== undefined && (!isStr(a.health.warnPath) || !a.health.warnPath.startsWith('/'))) {
        errors.push(`${where}: health.warnPath must start with "/"`);
      }
    }

    if (a.mcp !== undefined) {
      if (!isObj(a.mcp)) errors.push(`${where}: "mcp" must be an object`);
      else {
        unknownKeys(a.mcp, MCP_KEYS, `${where}.mcp`, errors);
        if (!isStr(a.mcp.path) || !a.mcp.path.startsWith('/')) errors.push(`${where}: mcp.path must start with "/"`);
        const u = a.mcp.unauthenticatedStatusOk;
        if (u !== undefined && (!Array.isArray(u) || u.some((n) => !Number.isInteger(n)))) {
          errors.push(`${where}: mcp.unauthenticatedStatusOk must be an array of integers`);
        }
        const b = a.mcp.authBearerSecret;
        if (b !== undefined) {
          if (!isStr(b)) errors.push(`${where}: mcp.authBearerSecret must be a string`);
          else if (!(a.requiredSecrets || []).includes(b)) errors.push(`${where}: mcp.authBearerSecret "${b}" is not listed in requiredSecrets`);
        }
      }
    }
  });
  return errors;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Compare two lists of app definitions by name. Key order is irrelevant. */
export function planChanges(oldDefs, newDefs) {
  const oldBy = new Map(oldDefs.map((d) => [d.name, d]));
  const newBy = new Map(newDefs.map((d) => [d.name, d]));
  const added = [], removed = [], changed = [], unchanged = [];
  for (const [name, d] of newBy) {
    if (!oldBy.has(name)) added.push(name);
    else if (stable(oldBy.get(name)) !== stable(d)) changed.push(name);
    else unchanged.push(name);
  }
  for (const name of oldBy.keys()) if (!newBy.has(name)) removed.push(name);
  return { added, removed, changed, unchanged };
}
