# @zhucher/dsh-file-drop

`dsh-file-drop` adds attachment, workspace-free chat, and conflict-preflight support to the DSH web profile:

- Drop a file or folder onto the conversation input. The composer shows a removable attachment chip with an icon, basename, and `File` or `Folder` label. The absolute or staged path stays out of the visible draft and is serialized through DSH's reference pipeline only when the message is submitted.
- Arbitrate overlapping drag handlers: image-only drops stay with DSH's native attachment plugin, ordinary files/folders are claimed here at capture phase, and AionUI workspace-path drags pass through to AionUI.
- Resolve the known duplicate `describe_image` composition in preflight by preferring `@dsh-plugin/dsh-auxiliary`, then writing an ID-targeted disable patch before the next normal startup.
- Diagnose other startup registry collisions with the same preflight command. It recognizes duplicate tools, web routes, input-trigger sources, sidebar tabs, file viewers, and web providers, then writes exact ID-targeted disable patches when ownership is unambiguous.
- Discover local MCP definitions from Codex, Claude, Cursor, workspace `.mcp.json` files, and installed plugin caches. Open **MCP Import** in the DSH sidebar and import a server with one click; the resulting `@deepseek-ai/dsh-mcp-client` entry is persisted in the active profile.
- Add a **General chat** sidebar action. It creates a session with the host launch directory as `cwd` but without a `workspaceId`, so the session stays under **Ungrouped** instead of being attached to a registered Workspace.

The upload route accepts only same-origin loopback requests, limits one file to 20 MiB and one drop to 50 MiB, rejects traversal and duplicate paths, and writes staged files with private permissions. Temporary drops older than 24 hours are removed when the host plugin starts.

## Install from GitHub

The repository ships runnable JavaScript, so DSH can install it directly without a build step:

```sh
dsh plugin --profile web add github:zhucherofficial/dsh-file-drop
```

Restart `dsh web` after installing.

Run the conflict preflight before restarting when several plugins expose overlapping features:

```sh
dsh plugin --profile web exec dsh-file-drop-resolve --profile web
```

Use `--check` for a read-only diagnosis. The resolver automatically keeps the selected `describe_image` owner and collapses exact duplicate package registrations. If two different implementations claim an unknown capability, it reports both owners and stops. Select one explicitly and rerun:

```sh
dsh plugin --profile web exec dsh-file-drop-resolve --profile web \
  --prefer tool:tool_name=preferred-package-or-entry-id
```

Before editing, the resolver backs up `~/.dsh/profiles/web/cordis.patch.yml`; after every applied rule it starts DSH on an ephemeral port and continues until the profile is healthy or an ambiguous/non-conflict failure is reached.

## Install from npm

The unscoped npm name `dsh-file-drop` belongs to a different project. This package uses a scope so the install command cannot resolve to that project. After the first public npm release, install it with:

```sh
dsh plugin --profile web add @zhucher/dsh-file-drop
```

The repository must keep `package.json`, `cordis.patch.yml`, and the `lib/` directory at its root. `dsh plugin` forwards the package spec to pnpm and automatically adds packages declaring `dsh.bundle.patch` to the web profile roster.

The browser entry is served through DSH's client-module loader. Keep `lib/client.js` as a self-registering `window.__ModuleLoader__.load(...)` bundle; a plain ESM export is not a valid web client entry.

Conflict repair is intentionally a preflight command rather than a runtime hook. DSH can abort while mounting an earlier plugin, before `dsh-file-drop` itself exists, so no ordinary plugin can recover every collision from inside the failed process. The resolver handles registration conflicts generically but does not guess between semantically different implementations: unknown ownership requires `--prefer`, and non-registration failures are reported without changing the profile.

## Local development

```sh
npm ci
npm test
dsh plugin --profile web add link:/absolute/path/to/dsh-file-drop
dsh plugin --profile web exec dsh-file-drop-resolve --profile web --check
```

Published behavior changes should include a Changeset created with `npm run changeset`. See [the release runbook](docs/RELEASING.md) for versioning, publishing, and recovery.

The third command changes the selected profile's dependency manifest. For a disposable verification profile, set `DSH_HOME` to a temporary directory before running it.

No credentials or remote service are used by the plugin itself. General chat relies on the blank-session phase behavior in DSH `0.1.1-rc.2`, so the package declares that release as its minimum supported DSH version.

MCP discovery never sends command lines, environment variables, headers, or credentials to the browser. Only display metadata is returned by the inventory route; the selected definition is resolved and persisted on the DSH host when you click Import.
