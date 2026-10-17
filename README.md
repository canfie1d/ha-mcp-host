# MCP Host

Home Assistant add-on repository. Contains one add-on, **MCP Host** (`mcp_host/`), which hosts,
health-checks and self-heals MCP servers. It ships with no app definitions; those live in the
add-on's private config dir.

Install: HA → Settings → Add-ons → Add-on Store → ⋮ → Repositories → add
`https://github.com/canfie1d/mcp-host`.

See [README.md](README.md) for configuration and cutover steps.

A Home Assistant OS add-on that hosts MCP servers and keeps them healthy.

## What it does

- Clones each app listed in `apps.json`, builds it, runs it, and exposes it on its own port.
- Every 30s runs a health check (HTTP path, then a real MCP `initialize` / `tools/list`).
- An optional `health.warnPath` is a notify-only check: a 5xx there (e.g. an expired upstream
  credential) sends a "needs attention" notification (re-sent every 12h) and flags the app, but
  never starts the healing ladder, since restarts, rollbacks and patches cannot fix it.
- After 3 consecutive failures it climbs a ladder, verifying health after each rung:
  1. restart
  2. clean reinstall + rebuild
  3. roll back to the last known-good commit
  4. **Claude diagnoses and patches** (only if `auto_patch` and an API key are set)
  5. give up for 30 min and push a notification
- Claude's edits are confined to the app's checkout, can't read `.env`/`.git`, and are only kept
  if the app comes back healthy. Kept patches are committed locally and, with a `github_token`,
  pushed to an `auto-fix/<timestamp>` branch for you to review and merge. Capped by
  `max_patches_per_day`.
- Status page appears in the HA sidebar ("MCP Host"); `status.json` has the raw data.
- **Edit apps.json in the UI**: the status page links to an editor (`/apps`). Save validates the file,
  keeps the previous one as `apps.json.bak`, and applies it live: new and edited apps are rebuilt and
  restarted, removed apps are stopped, untouched apps keep running. Use Validate for a dry run that
  shows what would change. The editor is only reachable through HA ingress (admin users).

## Install

1. Install the **Samba share** or **Advanced SSH & Web Terminal** add-on in HA.
2. Add this repository as a custom add-on repository (see the root README), or copy the `mcp_host/` folder into the `addons` share.
3. Settings > Add-ons > Add-on Store > ⋮ > Check for updates. "MCP Host" appears under Local add-ons.
4. Install, then open Configuration and fill in:
   - `anthropic_api_key`, `notify_service` (e.g. `notify.mobile_app_your_phone`)
   - `secrets`: one row per `app` / `name` / `value` (the names each app needs are in `apps.json`
     under `requiredSecrets`; the UI shows `needs-secrets` until all are present)
5. Define your apps. App definitions are **not** in this repo. On first start the add-on creates an
   empty `apps.json` in its private config dir (`/addon_configs/<id>_mcp_host/apps.json`, visible via
   Samba or the File editor add-on). Fill it in through the editor in the status page (or by hand using `apps.example.json` as the template).
6. Start it. First boot builds each app, so allow a few minutes.

## Expose it

Use the **Cloudflare Tunnel** add-on (or Tailscale Funnel) and map one hostname per app to
`http://<ha-host>:810x` (ports from `apps.json`). Then set each app's `PUBLIC_URL` secret to
its new public URL.

## Adding another MCP

Use "Add app template" in the editor (or append an entry to `apps.json` by hand), then Save & apply.
Add the app's secrets in the add-on Configuration. A port also needs adding to `config.yaml`
and an add-on rebuild.
## Known limitations

- Child processes share the add-on container; there is no per-app resource limit.
- Apps that need a persistent volume (e.g. a `/data` directory) need a `DATA_DIR`-style
  env pointing under `/data` — not yet wired into `apps.json`.
- Local patches are not auto-merged upstream; review the pushed `auto-fix/*` branches.
