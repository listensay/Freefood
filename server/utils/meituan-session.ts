import type { BrowserContextOptions } from "playwright-core";

function curlWords(text: string): string[] {
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (quote) {
      if (character === quote) quote = "";
      else if (
        character === "\\" &&
        quote === '"' &&
        ['"', "\\", "$", "`"].includes(text[i + 1] || "")
      )
        word += text[++i];
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (character === "\\") {
      if (text[i + 1] !== "\n") {
        word += text[++i] || "";
        started = true;
      } else i++;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) throw new Error("cURL 引号不完整");
  if (started) words.push(word);
  return words;
}

function curlCookie(text: string): string {
  const words = curlWords(text);
  const urls = words.filter((word) => /^https?:\/\//.test(word));
  if (words[0] !== "curl" || urls.length !== 1)
    throw new Error("请提供美团试吃官请求的 cURL");
  const url = new URL(urls[0]!);
  if (
    url.origin !== "https://offsiteact.meituan.com" ||
    !["/act/ge/getUserInfo", "/act/ge/queryPoiByRecallBiz"].includes(
      url.pathname,
    )
  )
    throw new Error("仅接受美团试吃官身份或活动请求");
  let cookie = "";
  for (let i = 1; i < words.length; i++) {
    const option = words[i]!;
    if (option === "-b" || option === "--cookie") cookie = words[++i] || "";
    else if (option.startsWith("--cookie=")) cookie = option.slice(9);
    else if (
      option === "-H" ||
      option === "--header" ||
      option.startsWith("--header=")
    ) {
      const header = option.startsWith("--header=")
        ? option.slice(9)
        : words[++i] || "";
      const match = /^cookie\s*:\s*(.*)$/i.exec(header);
      if (match) cookie = match[1]!;
    }
  }
  return cookie;
}

type Storage = Exclude<
  BrowserContextOptions["storageState"],
  string | undefined
>;

export function parseMeituanSession(input: unknown): Storage {
  if (typeof input !== "string" || !input.trim() || input.length > 64_000)
    throw new Error("请提供本人美团试吃官会话");
  const text = input.trim();
  let cookie: unknown;
  if (text.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("请求头 JSON 格式错误");
    }
    const headers = data.headers || data;
    if (!headers || typeof headers !== "object" || Array.isArray(headers))
      throw new Error("请求头 JSON 格式错误");
    cookie = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "cookie",
    )?.[1];
  } else if (/^curl\s/.test(text)) cookie = curlCookie(text);
  else cookie = text.replace(/^cookie\s*:\s*/i, "");
  if (typeof cookie !== "string" || !cookie.trim() || /[\r\n]/.test(cookie))
    throw new Error("请求缺少有效 Cookie");
  const seen = new Set<string>();
  const cookies = cookie
    .split(";")
    .filter((part) => part.trim())
    .map((part) => {
      const equals = part.indexOf("=");
      const name = part.slice(0, equals).trim(),
        value = part.slice(equals + 1).trim();
      if (
        equals <= 0 ||
        !/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/.test(name) ||
        name.length > 200 ||
        /[^\x20-\x7e]/.test(value) ||
        value.length > 16_000 ||
        seen.has(name)
      )
        throw new Error("Cookie 格式错误");
      seen.add(name);
      // A copied request proves only this host's cookies, not authorization for other domains.
      return {
        name,
        value,
        domain: "offsiteact.meituan.com",
        path: "/",
        expires: -1,
        // The H5 client reads its token cookie; a copied header has no HttpOnly metadata.
        httpOnly: false,
        secure: true,
        sameSite: "Lax" as const,
      };
    });
  if (!cookies.length || cookies.length > 200)
    throw new Error("Cookie 数量无效");
  return { cookies, origins: [] };
}
