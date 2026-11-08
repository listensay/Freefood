import { copyFile, chmod, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { buildService } from "./build.mjs";

if (process.platform !== "darwin") throw new Error("当前账号连接功能支持 macOS，请在 macOS 构建桌面应用");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("桌面服务需要 Node.js 24.16 或更高版本");
const host = /host: (.+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!target || target !== host) throw new Error("请在目标架构的 Mac 上构建对应安装包");
await buildService();
await mkdir("src-tauri/binaries", { recursive: true });
const output = `src-tauri/binaries/food-node-${target}`;
await copyFile(process.execPath, output); await chmod(output, 0o755);
