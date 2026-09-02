import assert from "node:assert/strict";
import test from "node:test";

import { assertNoPendingChangesets, assertReleaseTag } from "../scripts/verify-release.mjs";

test("accepts an exact stable tag newer than npm latest", () => {
  assert.doesNotThrow(() => assertReleaseTag("v1.2.3", "1.2.3", "1.2.2"));
});

test("rejects a mismatched version tag", () => {
  assert.throws(
    () => assertReleaseTag("v1.2.4", "1.2.3", "1.2.2"),
    /does not match package version 1\.2\.3/
  );
});

test("rejects a missing release tag", () => {
  assert.throws(() => assertReleaseTag(undefined, "1.2.3", "1.2.2"), /release tag is required/);
});

test("rejects prerelease versions from the stable workflow", () => {
  assert.throws(
    () => assertReleaseTag("v1.2.3-beta.1", "1.2.3-beta.1", "1.2.2"),
    /Prerelease version/
  );
});

test("rejects versions that do not advance npm latest", () => {
  assert.throws(
    () => assertReleaseTag("v1.2.3", "1.2.3", "1.2.3"),
    /must be newer than npm latest/
  );
});

test("accepts a Changesets directory with no pending entries", () => {
  assert.doesNotThrow(() => assertNoPendingChangesets(["config.json", "README.md"]));
});

test("rejects a tagged tree with unconsumed Changesets", () => {
  assert.throws(
    () => assertNoPendingChangesets(["config.json", "pending-release.md"]),
    /unconsumed Changesets: pending-release\.md/
  );
});
