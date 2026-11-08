import { isTauri, invoke } from "@tauri-apps/api/core";
import { $fetch, type FetchOptions } from "ofetch";

type Options = Pick<FetchOptions, "method" | "body" | "headers" | "timeout">;
export async function apiFetch<T>(path: string, options: Options = {}): Promise<T> {
  if (!isTauri()) return $fetch<T>(path, options as FetchOptions<"json">);
  if (!/^\/api\/[a-z0-9\/-]+$/.test(path)) throw new Error("请求地址无效");
  const response = await invoke<{ status: number; body: string }>("api_request", {
    path, method: options.method || "GET",
    body: options.body === undefined ? null : JSON.stringify(options.body),
    timeoutMs: options.timeout ?? 600_000,
  }).catch(cause => { throw cause instanceof Error ? cause : new Error(String(cause || "本地服务连接失败")); });
  let data: any;
  try { data = JSON.parse(response.body); } catch { throw new Error("服务响应无效"); }
  if (response.status >= 400) throw Object.assign(new Error(data.statusMessage || "请求失败"), {
    statusCode: response.status, statusMessage: data.statusMessage, data,
  });
  return data as T;
}
