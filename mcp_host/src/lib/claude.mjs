import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { log } from './util.mjs';

const MAX_TURNS = 14;
const MAX_READ = 60_000;
const BLOCKED = /(^|\/)(\.git|node_modules|\.env[^/]*)(\/|$)/;

const TOOLS = [
  {
    name: 'list_dir',
    description: 'List files in a directory of the repo (relative path, "." for root).',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the repo.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the repo with the full new contents.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'rebuild_and_check',
    description:
      'Rebuild the app, restart it, and run the health check. Call this after editing files. Returns build output and health result.',
    input_schema: { type: 'object', properties: {} },
  },
];

function safePath(repoDir, rel) {
  const abs = path.resolve(repoDir, rel);
  if (abs !== repoDir && !abs.startsWith(repoDir + path.sep)) throw new Error('path escapes repo');
  if (BLOCKED.test(path.relative(repoDir, abs))) throw new Error('path is not accessible');
  return abs;
}

/**
 * Ask Claude to diagnose and patch an app. Returns { fixed, summary }.
 * `rebuild` is supplied by the caller: async () => ({ ok, detail, buildOutput }).
 */
export async function patchWithClaude({ options, app, repoDir, failure, logs, gitLog, rebuild }) {
  if (!options.anthropic_api_key) throw new Error('anthropic_api_key is not configured');

  const system = [
    `You repair a crashing Node.js service called "${app.name}" that is hosted by an automated supervisor.`,
    `Description: ${app.description}`,
    `Build command: ${app.build}`,
    `Start command: ${app.start}`,
    'Make the smallest change that fixes the root cause. Do not refactor, do not touch secrets or .env files,',
    'do not add dependencies unless the failure is a missing one. Always verify with rebuild_and_check.',
    'If the failure is environmental (missing secret, network, upstream outage) and no code change can fix it,',
    'stop without editing anything and explain. Finish with a one-paragraph summary of cause and fix.',
  ].join('\n');

  const messages = [
    {
      role: 'user',
      content: `Health failure: ${failure}\n\nRecent commits:\n${gitLog}\n\nRecent process output (tail):\n${logs}`,
    },
  ];

  let edited = false;
  let fixed = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': options.anthropic_api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.claude_model,
        max_tokens: 4096,
        system,
        tools: TOOLS,
        messages,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    messages.push({ role: 'assistant', content: body.content });

    const uses = body.content.filter((b) => b.type === 'tool_use');
    if (body.stop_reason !== 'tool_use' || uses.length === 0) {
      const summary = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { fixed: fixed && edited, summary, edited };
    }

    const results = [];
    for (const use of uses) {
      let out;
      try {
        out = await runTool(use, { repoDir, rebuild, onEdit: () => (edited = true), onCheck: (ok) => (fixed = ok) });
      } catch (err) {
        out = `ERROR: ${err.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: String(out).slice(0, MAX_READ) });
    }
    messages.push({ role: 'user', content: results });
  }

  log(app.name, 'claude hit the turn limit');
  return { fixed: false, summary: 'Stopped: reached the turn limit without a verified fix.', edited };
}

async function runTool(use, { repoDir, rebuild, onEdit, onCheck }) {
  const input = use.input || {};
  switch (use.name) {
    case 'list_dir': {
      const dir = safePath(repoDir, input.path || '.');
      return readdirSync(dir)
        .filter((n) => !BLOCKED.test(n))
        .map((n) => (statSync(path.join(dir, n)).isDirectory() ? n + '/' : n))
        .join('\n');
    }
    case 'read_file': {
      const file = safePath(repoDir, input.path);
      return readFileSync(file, 'utf8').slice(0, MAX_READ);
    }
    case 'write_file': {
      const file = safePath(repoDir, input.path);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, input.content);
      onEdit();
      return `wrote ${input.path} (${input.content.length} bytes)`;
    }
    case 'rebuild_and_check': {
      const r = await rebuild();
      onCheck(r.ok);
      return `${r.ok ? 'HEALTHY' : 'STILL FAILING'}: ${r.detail}\n\nbuild output (tail):\n${r.buildOutput.slice(-4000)}`;
    }
    default:
      throw new Error(`unknown tool ${use.name}`);
  }
}
