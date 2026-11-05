import type { RemoteBrowserAction } from "../../shared/types";

const keys = new Set([
  "Backspace",
  "Delete",
  "Tab",
  "Shift+Tab",
  "Enter",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ControlOrMeta+A",
]);

export function parseRemoteAction(
  input: unknown,
  viewport: { width: number; height: number },
): RemoteBrowserAction {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("操作格式错误");
  const action = input as Record<string, unknown>;
  switch (action.type) {
    case "pointer": {
      if (
        typeof action.phase !== "string" ||
        !["down", "move", "up"].includes(action.phase) ||
        typeof action.x !== "number" ||
        !Number.isFinite(action.x) ||
        action.x < 0 ||
        action.x >= viewport.width ||
        typeof action.y !== "number" ||
        !Number.isFinite(action.y) ||
        action.y < 0 ||
        action.y >= viewport.height
      )
        throw new Error("操作坐标无效");
      return {
        type: "pointer",
        phase: action.phase as "down" | "move" | "up",
        x: action.x,
        y: action.y,
      };
    }
    case "text":
      if (
        typeof action.text !== "string" ||
        !action.text.length ||
        action.text.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(action.text)
      )
        throw new Error("输入内容无效");
      return { type: "text", text: action.text };
    case "key":
      if (typeof action.key !== "string" || !keys.has(action.key))
        throw new Error("不支持该按键");
      return { type: "key", key: action.key };
    case "wheel":
      if (
        typeof action.deltaX !== "number" ||
        !Number.isFinite(action.deltaX) ||
        Math.abs(action.deltaX) > 2000 ||
        typeof action.deltaY !== "number" ||
        !Number.isFinite(action.deltaY) ||
        Math.abs(action.deltaY) > 2000
      )
        throw new Error("滚动距离无效");
      return { type: "wheel", deltaX: action.deltaX, deltaY: action.deltaY };
    case "reload":
      return { type: "reload" };
    default:
      throw new Error("不支持该操作");
  }
}

export function isMeituanPage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["meituan.com", "dianping.com", "sankuai.com"].some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}
