# Changelog

## 1.0.13

- Show stored secrets on app pages (#10)

## 1.0.12

- Timestamp app logs, show host messages there, and add Copy/Download (#9)

## 1.0.11

- Update checkouts that the build left with modified tracked files (#8)

## 1.0.10

- Add a changelog for the HA update screen (#7)

## 1.0.9

- Fix the Restart and Pull & rebuild buttons, which failed with "Cannot read properties of undefined (reading 'missing')".
- An app's version is its release tag (`git describe --tags`), falling back to `package.json`.
- New Upstream row on each app page: shows when the checkout is behind its branch or has local commits (usually an auto-fix patch) that stop Pull & rebuild from updating it.

## 1.0.8

- The MCP Host panel has a side nav with a page per hosted app: status, Restart and Pull & rebuild, deployed version and commit, secrets, live logs and incidents.
- Secrets are set on each app's page and stored in `/data`. The old `secrets` list in Configuration is imported once, then ignored; delete its entries afterwards.
- Readable names and descriptions for the Configuration options.

## 1.0.7

- `ANTHROPIC_API_KEY` environment variable overrides the configured key, for local development.

## 1.0.6

- App settings link on the status and editor pages.

## 1.0.5

- README covers configuration and cutover steps.

## 1.0.4

- Status page layout matches the other add-on UIs.

## 1.0.3

- Status page restyled as a card dashboard.

## 1.0.1

- Images are built by CI and published to GHCR.
