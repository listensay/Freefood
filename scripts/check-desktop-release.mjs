import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkReleaseVersion({ packageJson, packageLock, tauri, cargo, cargoLock }, tag) {
  const version = packageJson.version;
  const semver = typeof version === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!semver || semver[0] !== version || semver[1]?.split(".").some(part => /^0\d+$/.test(part)))
    throw new Error("package.json 必须使用有效的 SemVer 版本号");
  const packageSection = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const lockedPackage = cargoLock.split("[[package]]").find(block => /^name\s*=\s*"freefood"\s*$/m.test(block));
  const tomlVersion = text => /^version\s*=\s*"([^"]+)"/m.exec(text || "")?.[1];
  for (const [file, actual] of [
    ["package-lock.json", packageLock.version],
    ["package-lock.json packages[\"\"]", packageLock.packages?.[""]?.version],
    ["src-tauri/tauri.conf.json", tauri.version],
    ["src-tauri/Cargo.toml", tomlVersion(packageSection)],
    ["src-tauri/Cargo.lock", tomlVersion(lockedPackage)],
  ]) {
    if (actual !== version) throw new Error(`${file} 版本必须为 ${version}，当前为 ${actual ?? "未设置"}`);
  }
  if (tag !== undefined && tag !== `v${version}`)
    throw new Error(`发布标签必须为 v${version}，当前为 ${tag}`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const json = async path => JSON.parse(await readFile(path, "utf8"));
  const tag = process.argv[2] ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME ?? "" : undefined);
  const version = checkReleaseVersion({
    packageJson: await json("package.json"), packageLock: await json("package-lock.json"),
    tauri: await json("src-tauri/tauri.conf.json"),
    cargo: await readFile("src-tauri/Cargo.toml", "utf8"), cargoLock: await readFile("src-tauri/Cargo.lock", "utf8"),
  }, tag);
  console.log(version);
}
