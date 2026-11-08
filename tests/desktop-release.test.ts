import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkReleaseVersion } from "../scripts/check-desktop-release.mjs";

function metadata(version = "0.1.0") {
  return {
    packageJson: { version }, packageLock: { version, packages: { "": { version } } }, tauri: { version },
    cargo: `[package]\nname = "freefood"\nversion = "${version}"\n\n[dependencies]\nserde = "1"\n`,
    cargoLock: `version = 4\n\n[[package]]\nname = "another-crate"\nversion = "2.0.0"\n\n[[package]]\nname = "freefood"\nversion = "${version}"\n`,
  };
}

test("Desktop release tags match all application and lockfile versions", () => {
  for (const version of ["0.1.0", "1.2.3-beta.1", "2.0.0-rc.2+build.4"]) {
    assert.equal(checkReleaseVersion(metadata(version)), version);
    assert.equal(checkReleaseVersion(metadata(version), `v${version}`), version);
  }
});
test("Desktop releases reject inconsistent package, native and locked versions", () => {
  for (const change of [
    { packageJson: { version: "0.2.0" } }, { packageLock: { version: "0.2.0", packages: { "": { version: "0.1.0" } } } },
    { packageLock: { version: "0.1.0", packages: { "": { version: "0.2.0" } } } }, { tauri: { version: "0.2.0" } },
    { cargo: metadata("0.2.0").cargo }, { cargoLock: metadata("0.2.0").cargoLock },
    { cargo: "[package]\nname = \"freefood\"\n" }, { cargoLock: "version = 4\n" },
  ]) assert.throws(() => checkReleaseVersion({ ...metadata(), ...change }), /版本/);
});
test("Desktop releases reject malformed versions and mismatched or unsafe tags", () => {
  for (const version of ["01.2.3", "1.2", "v1.2.3", "1.2.3-01", "1.2.3-beta..1", "1.2.3\n", "1.2.3\nrelease", "../release"])
    assert.throws(() => checkReleaseVersion(metadata(version)), /SemVer/);
  for (const tag of ["", "0.1.0", "v0.2.0", "v0.1.0\nrelease", "v0.1.0;echo invalid"])
    assert.throws(() => checkReleaseVersion(metadata(), tag), /发布标签/);
});
test("The checked-in desktop release metadata stays synchronized", () => {
  const result = execFileSync(process.execPath, ["scripts/check-desktop-release.mjs"], {
    encoding: "utf8", env: { ...process.env, GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
  });
  assert.match(result.trim(), /^\d+\.\d+\.\d+/);
});
