# Releasing

Releases use reviewed version changes, a GitHub Release, and npm Trusted Publishing. Do not run `npm publish` from a developer machine.

## One-time npm configuration

Configure the npm Trusted Publisher for `@zhucher/dsh-file-drop` with these exact values:

- Provider: GitHub Actions
- Organization or user: `zhucherofficial`
- Repository: `dsh-file-drop`
- Workflow filename: `publish.yml`
- Environment: `npm-publish`
- Allowed action: `npm publish` only

The workflow uses GitHub OIDC and does not require an `NPM_TOKEN` secret. Set package publishing access to require two-factor authentication and disallow bypass-2FA tokens; Trusted Publishing remains available.

## Record a change

Every pull request that changes published behavior should include a Changeset:

```sh
npm ci
npm run changeset
```

Select `patch`, `minor`, or `major` and write a user-facing summary. Documentation and CI-only changes should include an empty Changeset:

```sh
npm run changeset:empty
```

CI requires a newly added non-README Changeset on ordinary pull requests. A version pull request is exempt only when it updates the changelog and lockfile and consumes a pre-existing Changeset for this package.

## Prepare the release

From an up-to-date `main` branch, consume all pending Changesets on a release branch:

```sh
git switch main
git pull --ff-only
git switch -c release/version-packages
npm ci
npm run version-packages
npm install --package-lock-only --ignore-scripts
npm test
git add package.json package-lock.json CHANGELOG.md .changeset
git commit -m "Version packages"
git push -u origin release/version-packages
gh pr create --fill
```

Review the generated version and changelog in the pull request. Merge only after CI passes.

## Publish

Immediately after the version pull request is merged, update local `main` and capture that exact reviewed commit. Publish a GitHub Release whose tag is `v` plus the version in that commit:

```sh
git switch main
git pull --ff-only
RELEASE_COMMIT=$(git rev-parse HEAD)
VERSION=$(node -p "require('./package.json').version")
gh release create "v${VERSION}" --target "$RELEASE_COMMIT" --generate-notes --title "v${VERSION}"
```

Do not retarget the release to a later `main` tip. Publishing the GitHub Release starts `.github/workflows/publish.yml`. The workflow serializes releases, verifies the tag and exact version are newer than npm `latest`, rejects prereleases and unconsumed Changesets, checks that the tagged commit belongs to `main`, and runs tests without OIDC access.

The validation job packages the release with lifecycle scripts disabled. Only its tarball enters the environment-gated publish job, which receives `id-token: write` and publishes the tarball with provenance and scripts disabled.

## Recovery

- If validation or npm publishing fails, inspect the failed job before changing the release. npm versions are immutable.
- If the failure was transient and npm does not contain the version, rerun the failed GitHub Actions job.
- If source or version validation fails, close the GitHub Release, fix the cause in a new version pull request, and create a new version. Do not move an existing release tag.
- If npm contains the version but the GitHub run appears failed afterward, do not increment or republish automatically; compare the npm package `gitHead` and provenance with the release tag first.
- Never delete and recreate an npm version. Deprecate a bad version and publish a corrected patch instead.
