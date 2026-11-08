import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createError } from "h3";

const execute = promisify(execFile);
const service = "com.freefood.desktop.session-key";
export async function sessionEncryptionKey(directory: string, existingDatabase: boolean): Promise<Buffer> {
  // Explicit key injection supports headless deployments and isolated tests, never a browser request.
  const supplied = process.env.FOOD_SESSION_KEY;
  if (supplied !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(supplied)) throw new Error("FOOD_SESSION_KEY must contain 64 hexadecimal characters");
    return Buffer.from(supplied, "hex");
  }
  if (process.platform !== "darwin")
    throw createError({ statusCode: 503, statusMessage: "请配置本机数据加密密钥" });
  const account = createHash("sha256").update(resolve(directory)).digest("hex");
  try {
    const { stdout } = await execute("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"],
      { timeout: 60_000, maxBuffer: 4096 });
    const value = stdout.trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Invalid keychain key");
    return Buffer.from(value, "hex");
  } catch (error: any) {
    if (error.code !== 44 || existingDatabase)
      throw createError({ statusCode: 503, statusMessage: "数据密钥无法读取，请检查系统钥匙串" });
  }
  const key = randomBytes(32);
  try {
    await execute("/usr/bin/security", ["add-generic-password", "-s", service, "-a", account, "-w", key.toString("hex")],
      { timeout: 60_000, maxBuffer: 4096 });
    return key;
  } catch {
    key.fill(0);
    throw createError({ statusCode: 503, statusMessage: "数据密钥保存失败，请检查系统钥匙串" });
  }
}
