const PROBE_TIMEOUT_MS = 8000;

async function probe(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns { ok, detail }. Two layers:
 *  1. plain HTTP health path
 *  2. real MCP handshake (initialize, then tools/list when a session is issued)
 */
export async function checkApp(app, secrets) {
  const base = `http://127.0.0.1:${app.port}`;

  try {
    const res = await probe(base + app.health.path);
    if (res.status >= 500) return { ok: false, detail: `health ${app.health.path} -> ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `health ${app.health.path} unreachable: ${err.message}` };
  }

  if (!app.mcp) return { ok: true, detail: 'http ok' };

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const token = app.mcp.authBearerSecret && secrets[app.mcp.authBearerSecret];
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const init = await probe(base + app.mcp.path, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mcp-host-supervisor', version: '0.1.0' },
        },
      }),
    });

    // An OAuth-protected MCP legitimately answers 401 without credentials: it is alive.
    if (!token && (app.mcp.unauthenticatedStatusOk || []).includes(init.status)) {
      return { ok: true, detail: `mcp alive (${init.status} without credentials)` };
    }
    if (!init.ok) return { ok: false, detail: `mcp initialize -> ${init.status}` };

    const session = init.headers.get('mcp-session-id');
    if (session) {
      headers['mcp-session-id'] = session;
      const list = await probe(base + app.mcp.path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      if (list.status >= 500) return { ok: false, detail: `mcp tools/list -> ${list.status}` };
    }
    return { ok: true, detail: 'mcp handshake ok' };
  } catch (err) {
    return { ok: false, detail: `mcp handshake failed: ${err.message}` };
  }
}
