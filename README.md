# dsh-file-drop

`dsh-file-drop` adds attachment, workspace-free chat, and conflict-preflight support to the DSH web profile:

- Drop a file or folder onto the conversation input. The composer shows a removable attachment chip with an icon, basename, and `File` or `Folder` label. The absolute or staged path stays out of the visible draft and is serialized through DSH's reference pipeline only when the message is submitted.
- Arbitrate overlapping drag handlers: image-only drops stay with DSH's native attachment plugin, ordinary files/folders are claimed here at capture phase, and AionUI workspace-path drags pass through to AionUI.
- Resolve the known duplicate `describe_image` composition by selecting `@dsh-plugin/dsh-auxiliary` as the owner and disabling the aggregate `web-ui-describe-image` entry. This is a declarative loader patch applied before startup, so it prevents the registry exception instead of trying to recover after a crash.
- Diagnose other startup registry collisions with a preflight command. It recognizes duplicate tools, web routes, input-trigger sources, sidebar tabs, file viewers, and web providers, then writes exact ID-targeted disable patches when ownership is unambiguous.
- Add a **General chat** sidebar action. It creates a session with DSH's normal default `cwd` but without a `workspaceId`, so the session is not attached to a registered Workspace.

The upload route accepts only same-origin loopback requests, limits one file to 20 MiB and one drop to 50 MiB, rejects traversal and duplicate paths, and writes staged files with private permissions. Temporary drops older than 24 hours are removed when the host plugin starts.

## Install from npm

Publish this package as a public npm package, then users can install it with the exact DSH plugin command:

```sh
dsh plugin --profile web add dsh-file-drop
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

## Install directly from GitHub

After pushing this directory to `zhu1090093659/dsh-file-drop` (or changing the account in `package.json`), pnpm accepts a GitHub shorthand or a Git URL through the same DSH forwarder:

```sh
dsh plugin --profile web add github:zhu1090093659/dsh-file-drop
# or
dsh plugin --profile web add git+https://github.com/YOUR_ACCOUNT/dsh-file-drop.git
```

The repository must keep `package.json`, `cordis.patch.yml`, and the `lib/` directory at its root. `dsh plugin` forwards the package spec to pnpm and automatically adds packages declaring `dsh.bundle.patch` to the web profile roster.

The browser entry is served through DSH's client-module loader. Keep `lib/client.js` as a self-registering `window.__ModuleLoader__.load(...)` bundle; a plain ESM export is not a valid web client entry.

Conflict repair is intentionally a preflight command rather than a runtime hook. DSH can abort while mounting an earlier plugin, before `dsh-file-drop` itself exists, so no ordinary plugin can recover every collision from inside the failed process. The resolver handles registration conflicts generically but does not guess between semantically different implementations: unknown ownership requires `--prefer`, and non-registration failures are reported without changing the profile.

## Local development

```sh
npm test
dsh plugin --profile web add link:/absolute/path/to/dsh-file-drop
dsh plugin --profile web exec dsh-file-drop-resolve --profile web --check
```

The second command changes the selected profile's dependency manifest. For a disposable verification profile, set `DSH_HOME` to a temporary directory before running it.

No credentials or remote are assumed by the plugin itself.
