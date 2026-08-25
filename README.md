# dsh-file-drop

`dsh-file-drop` adds two small pieces to the DSH web profile:

- Drop a file or folder onto the conversation input. Native absolute paths are referenced directly when the host exposes them. In a normal browser, the plugin uploads the dropped bytes to a private temporary directory and inserts the resulting `@path` references into the draft. Images are left to DSH's built-in image-drop pipeline.
- Add a **General chat** sidebar action. It creates a session with DSH's normal default `cwd` but without a `workspaceId`, so the session is not attached to a registered Workspace.

The upload route accepts only same-origin loopback requests, limits one file to 20 MiB and one drop to 50 MiB, rejects traversal and duplicate paths, and writes staged files with private permissions. Temporary drops older than 24 hours are removed when the host plugin starts.

## Install from npm

Publish this package as a public npm package, then users can install it with the exact DSH plugin command:

```sh
dsh plugin --profile web add dsh-file-drop
```

Restart `dsh web` after installing.

## Install directly from GitHub

After pushing this directory to `zhu1090093659/dsh-file-drop` (or changing the account in `package.json`), pnpm accepts a GitHub shorthand or a Git URL through the same DSH forwarder:

```sh
dsh plugin --profile web add github:zhu1090093659/dsh-file-drop
# or
dsh plugin --profile web add git+https://github.com/YOUR_ACCOUNT/dsh-file-drop.git
```

The repository must keep `package.json`, `cordis.patch.yml`, and the `lib/` directory at its root. `dsh plugin` forwards the package spec to pnpm and automatically adds packages declaring `dsh.bundle.patch` to the web profile roster.

## Local development

```sh
npm test
dsh plugin --profile web add link:/absolute/path/to/dsh-file-drop
```

The second command changes the selected profile's dependency manifest. For a disposable verification profile, set `DSH_HOME` to a temporary directory before running it.

## GitHub publishing

The workspace is intentionally not tied to a particular GitHub account. Replace the placeholder repository URL in `package.json`, create the repository, then run:

```sh
git init
git add package.json cordis.patch.yml lib README.md test
git commit -m "Initial dsh-file-drop plugin"
git branch -M main
git remote add origin https://github.com/zhu1090093659/dsh-file-drop.git
git push -u origin main
```

No credentials or remote are assumed by the plugin itself.
