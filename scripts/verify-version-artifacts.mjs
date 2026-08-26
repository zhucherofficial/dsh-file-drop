import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import parseChangeset from "@changesets/parse";
import semver from "semver";

const BUMP_PRIORITY = { patch: 0, minor: 1, major: 2 };

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function assertVersionArtifacts({
  packageName,
  previousVersion,
  version,
  lockfileVersion,
  lockfileRootVersion,
  changelog,
  consumedChangesets,
}) {
  if (!semver.valid(previousVersion) || !semver.valid(version)) {
    throw new Error(`Version change must use valid SemVer: ${previousVersion} -> ${version}.`);
  }
  if (lockfileVersion !== version || lockfileRootVersion !== version) {
    throw new Error(`package-lock.json versions must both equal package version ${version}.`);
  }

  const versionHeading = new RegExp(`^##\\s+${escapeRegExp(version)}(?:\\s|$)`, "mu");
  if (!versionHeading.test(changelog)) {
    throw new Error(`CHANGELOG.md does not contain a heading for version ${version}.`);
  }

  const releaseTypes = [];
  for (const { path, content } of consumedChangesets) {
    if (!/^\.changeset\/[^/]+\.md$/iu.test(path) || /\/README\.md$/iu.test(path)) {
      continue;
    }
    const parsed = parseChangeset(content);
    for (const release of parsed.releases) {
      if (release.name === packageName && release.type in BUMP_PRIORITY) {
        releaseTypes.push(release.type);
      }
    }
  }

  if (releaseTypes.length === 0) {
    throw new Error(`No consumed Changeset schedules a release for ${packageName}.`);
  }
  const bumpType = releaseTypes.reduce((highest, current) =>
    BUMP_PRIORITY[current] > BUMP_PRIORITY[highest] ? current : highest,
  );
  const expectedVersion = semver.inc(previousVersion, bumpType);
  if (version !== expectedVersion) {
    throw new Error(`Consumed Changesets require ${bumpType} version ${expectedVersion}, not ${version}.`);
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function main() {
  const baseRef = process.argv[2];
  if (!baseRef) {
    throw new Error("A base Git revision is required.");
  }

  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const previousPackageJson = JSON.parse(git(["show", `${baseRef}:package.json`]));
  const deletedOutput = git(["diff", "--diff-filter=D", "--name-only", baseRef, "HEAD", "--", ".changeset/*.md"]);
  const deletedPaths = deletedOutput ? deletedOutput.split("\n") : [];
  const consumedChangesets = deletedPaths.map((path) => ({
    path,
    content: git(["show", `${baseRef}:${path}`]),
  }));

  assertVersionArtifacts({
    packageName: packageJson.name,
    previousVersion: previousPackageJson.version,
    version: packageJson.version,
    lockfileVersion: packageLock.version,
    lockfileRootVersion: packageLock.packages?.[""]?.version,
    changelog,
    consumedChangesets,
  });
  console.log(`Verified version artifacts for ${packageJson.name}@${packageJson.version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
