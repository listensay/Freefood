import test from "node:test";
import assert from "node:assert/strict";
import { parseRemoteAction, isMeituanPage } from "../server/utils/remote-input";
import {
  activityAccessError,
  MEITUAN_LOGIN_URL,
  passportLoginIdentity,
} from "../server/utils/meituan-login";
const viewport = { width: 480, height: 680 };

test("remote input accepts only bounded pointer, text, key, wheel and reload operations", () => {
  assert.deepEqual(
    parseRemoteAction(
      { type: "pointer", phase: "down", x: 24, y: 175 },
      viewport,
    ),
    { type: "pointer", phase: "down", x: 24, y: 175 },
  );
  assert.deepEqual(
    parseRemoteAction({ type: "text", text: "中文输入 123456" }, viewport),
    { type: "text", text: "中文输入 123456" },
  );
  assert.deepEqual(
    parseRemoteAction({ type: "key", key: "ControlOrMeta+A" }, viewport),
    { type: "key", key: "ControlOrMeta+A" },
  );
  assert.deepEqual(
    parseRemoteAction({ type: "wheel", deltaX: 0, deltaY: -300 }, viewport),
    { type: "wheel", deltaX: 0, deltaY: -300 },
  );
  assert.deepEqual(
    parseRemoteAction(
      { type: "reload", url: "https://evil.example" },
      viewport,
    ),
    { type: "reload" },
  );
});
test("remote input rejects scripts, navigation, clipboard reads, invalid keys and oversized input", () => {
  for (const action of [
    null,
    [],
    { type: "evaluate", script: "document.cookie" },
    { type: "goto", url: "http://localhost" },
    { type: "clipboard" },
    { type: "key", key: "ControlOrMeta+L" },
    { type: "key", key: "F12" },
    { type: "pointer", phase: "down", x: -1, y: 0 },
    { type: "pointer", phase: "up", x: 480, y: 0 },
    { type: "pointer", phase: "move", x: 0, y: Infinity },
    { type: "pointer", phase: "click", x: 0, y: 0 },
    { type: "text", text: "x".repeat(2001) },
    { type: "text", text: "\u0000" },
    { type: "wheel", deltaX: 0, deltaY: 2001 },
  ])
    assert.throws(() => parseRemoteAction(action, viewport));
});
test("remote navigation is limited to HTTPS official Meituan and login domains", () => {
  for (const url of [
    "https://offsiteact.meituan.com/",
    "https://passport.meituan.com/",
    "https://account.dianping.com/",
    "https://auth.sankuai.com/",
  ])
    assert.equal(isMeituanPage(url), true);
  for (const url of [
    "http://meituan.com/",
    "https://meituan.com.evil.example/",
    "https://evilmeituan.com/",
    "file:///tmp/test",
    "javascript:alert(1)",
    "http://127.0.0.1/",
  ])
    assert.equal(isMeituanPage(url), false);
});
test("login uses the independent official passport and only accepts an authenticated response", () => {
  const url = new URL(MEITUAN_LOGIN_URL);
  assert.equal(url.hostname, "passport.meituan.com");
  assert.equal(url.pathname, "/account/unitivelogin");
  assert.equal(url.searchParams.get("continue"), "https://www.meituan.com/");
  assert.equal(
    passportLoginIdentity({ user: { id: 123, token: "test" } }),
    "123",
  );
  for (const data of [
    { user: { id: 123 } },
    { user: { token: "test" } },
    { error: { code: 403 }, user: { id: 123, token: "test" } },
    { user: { id: 0, token: "test" } },
    { user: { id: 123, token: "" } },
  ])
    assert.equal(passportLoginIdentity(data), undefined);
  assert.match(activityAccessError(403, "page"), /拒绝访问/);
  assert.doesNotMatch(activityAccessError(403, "page"), /完成.*验证/);
});
