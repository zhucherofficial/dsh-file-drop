import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import semver from "semver";

export function assertReleaseTag(tag, packageVersion, latestVersion) {
  if (!tag) {
    throw new Error("A release tag is required.");
  }
  if (!semver.valid(packageVersion)) {
    throw new Error(`Package version ${packageVersion} is not valid SemVer.`);
  }
  if (semver.prerelease(packageVersion)) {
    throw new Error(`Prerelease version ${packageVersion} cannot use the stable publishing workflow.`);
  }

  const expectedTag = `v${packageVersion}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag} does not match package version ${packageVersion}; expected ${expectedTag}.`);
  }

  if (latestVersion) {
    if (!semver.valid(latestVersion)) {
      throw new Error(`Published latest version ${latestVersion} is not valid SemVer.`);
    }
    if (!semver.gt(packageVersion, latestVersion)) {
      throw new Error(`Release version ${packageVersion} must be newer than npm latest ${latestVersion}.`);
    }
  }
}

export function assertNoPendingChangesets(files) {
  const pending = files.filter((file) => file.endsWith(".md") && file !== "README.md");
  if (pending.length > 0) {
    throw new Error(`Release contains unconsumed Changesets: ${pending.join(", ")}.`);
  }
}

async function main() {
  const tag = process.argv[2];
  const latestVersion = process.env.LATEST_VERSION?.trim();
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const changesetFiles = await readdir(new URL("../.changeset/", import.meta.url));

  if (!latestVersion) {
    throw new Error("The current npm latest version is required.");
  }
  assertReleaseTag(tag, packageJson.version, latestVersion);
  assertNoPendingChangesets(changesetFiles);
  if (packageJson.private) {
    throw new Error(`${packageJson.name} is marked private and cannot be published.`);
  }

  console.log(`Verified ${packageJson.name}@${packageJson.version} for ${tag}; npm latest is ${latestVersion}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
