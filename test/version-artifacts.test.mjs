import assert from "node:assert/strict";
import test from "node:test";

import { assertVersionArtifacts } from "../scripts/verify-version-artifacts.mjs";

const validInput = {
  packageName: "@example/package",
  previousVersion: "1.2.3",
  version: "1.2.4",
  lockfileVersion: "1.2.4",
  lockfileRootVersion: "1.2.4",
  changelog: "# Changelog\n\n## 1.2.4\n\n- Fixed release.\n",
  consumedChangesets: [{
    path: ".changeset/fix-release.md",
    content: "---\n\"@example/package\": patch\n---\n\nFixed release.\n",
  }],
};

test("accepts matching Changesets-generated version artifacts", () => {
  assert.doesNotThrow(() => assertVersionArtifacts(validInput));
});

test("rejects mismatched lockfile versions", () => {
  assert.throws(
    () => assertVersionArtifacts({ ...validInput, lockfileRootVersion: "1.2.3" }),
    /package-lock\.json versions must both equal/
  );
});

test("rejects a missing changelog heading", () => {
  assert.throws(
    () => assertVersionArtifacts({ ...validInput, changelog: "# Changelog\n" }),
    /does not contain a heading/
  );
});

test("rejects a package name mentioned only in empty Changeset prose", () => {
  assert.throws(
    () => assertVersionArtifacts({
      ...validInput,
      consumedChangesets: [{
        path: ".changeset/empty.md",
        content: "---\n---\n\nCI work for @example/package.\n",
      }],
    }),
    /No consumed Changeset schedules a release/
  );
});

test("ignores nested and README Changeset paths", () => {
  const content = validInput.consumedChangesets[0].content;
  assert.throws(
    () => assertVersionArtifacts({
      ...validInput,
      consumedChangesets: [
        { path: ".changeset/nested/release.md", content },
        { path: ".changeset/README.md", content },
      ],
    }),
    /No consumed Changeset schedules a release/
  );
});

test("rejects a version bump larger than the consumed Changeset", () => {
  assert.throws(
    () => assertVersionArtifacts({
      ...validInput,
      version: "1.3.0",
      lockfileVersion: "1.3.0",
      lockfileRootVersion: "1.3.0",
      changelog: "## 1.3.0\n",
    }),
    /require patch version 1\.2\.4, not 1\.3\.0/
  );
});
