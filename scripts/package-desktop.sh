#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
check_equal() {
  if [[ "$1" != "$2" ]]; then
    printf '%s：期望 %s，实际 %s\n' "$3" "$2" "$1" >&2
    exit 1
  fi
}
version=$(node scripts/check-desktop-release.mjs)
host=$(rustc -vV | sed -n 's/^host: //p')
target=${1:-$host}
if [[ "$target" != "$host" ]]; then
  echo "请在目标架构的 Mac 上验证安装包。" >&2
  exit 1
fi
case "$target" in
  aarch64-apple-darwin) arch=aarch64; binary_arch=arm64; dmg_arch=aarch64 ;;
  x86_64-apple-darwin) arch=x86_64; binary_arch=x86_64; dmg_arch=x64 ;;
  *) echo "不支持的构建目标：$target" >&2; exit 1 ;;
esac
bundle=src-tauri/target/release/bundle
if [[ $# -gt 0 ]]; then bundle="src-tauri/target/$target/release/bundle"; fi
shopt -s nullglob
apps=("$bundle"/macos/*.app)
dmgs=("$bundle"/dmg/*.dmg)
if [[ ${#apps[@]} -ne 1 || ${#dmgs[@]} -ne 1 ]]; then
  echo "需要一个 .app 和一个 .dmg，请先完成对应目标的构建。" >&2
  exit 1
fi
app=${apps[0]}
identifier=$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).identifier)')
check_equal "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" "$identifier" "应用标识不匹配"
check_equal "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" "$version" "应用版本不匹配"
if [[ "$(basename "${dmgs[0]}")" != *"_${version}_${dmg_arch}.dmg" ]]; then
  echo "安装包文件名与版本或架构不匹配。" >&2
  exit 1
fi
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
for binary in "$app/Contents/MacOS/$executable" "$app/Contents/MacOS/food-node"; do
  check_equal "$(lipo -archs "$binary")" "$binary_arch" "$binary 架构不匹配"
done
codesign --verify --deep --strict "$app"
check_equal "$("$app/Contents/MacOS/food-node" --version)" "$(node --version)" "Node.js 版本不匹配"
"$app/Contents/MacOS/food-node" --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  import assert from "node:assert/strict";
  const db = new DatabaseSync(":memory:");
  assert.equal(db.prepare("SELECT 1 AS ok").get().ok, 1);
  db.close();
'

output=dist/artifacts
prefix="Freefood_${version}_macos_${arch}"
mkdir -p "$output"
cp "${dmgs[0]}" "$output/$prefix.dmg"
ditto -c -k --sequesterRsrc --keepParent "$app" "$output/$prefix.app.zip"
(cd "$output" && shasum -a 256 "$prefix.dmg" "$prefix.app.zip" > "$prefix.sha256")
echo "$output/$prefix.dmg"
echo "$output/$prefix.app.zip"
