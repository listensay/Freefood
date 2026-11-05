import test from "node:test";
import assert from "node:assert/strict";
import { parseMeituanSession } from "../server/utils/meituan-session";
import { passportRequestIssue } from "../server/utils/meituan-login";

test("Meituan session import accepts Cookie and request-header JSON without trusting other headers", () => {
  for (const input of [
    "token=private-test-token; uuid=1",
    "Cookie: token=private-test-token; uuid=1",
    '{"headers":{"Cookie":"token=private-test-token; uuid=1","Host":"evil.example"}}',
    '{"cookie":"token=private-test-token; uuid=1"}',
  ]) {
    const storage = parseMeituanSession(input);
    assert.equal(storage.cookies.length, 2);
    assert.deepEqual(storage.origins, []);
    assert.equal(storage.cookies[0]?.value, "private-test-token");
    assert.equal(storage.cookies[0]?.domain, "offsiteact.meituan.com");
    assert.equal(storage.cookies[0]?.secure, true);
    assert.equal(storage.cookies[0]?.httpOnly, false);
  }
});
test("Meituan cURL is parsed as data, never executed and cannot target arbitrary hosts", () => {
  const text = `curl 'https://offsiteact.meituan.com/act/ge/getUserInfo' \\\n-H 'Cookie: token=private-test-token; uuid=1' --data-raw '{"command":"$(touch /tmp/do-not-execute)"}'`;
  assert.equal(parseMeituanSession(text).cookies.length, 2);
  assert.equal(
    parseMeituanSession(
      `curl "https://offsiteact.meituan.com/act/ge/queryPoiByRecallBiz" --cookie='token=private-test-token'`,
    ).cookies.length,
    1,
  );
  for (const url of [
    "https://evil.example/act/ge/getUserInfo",
    "http://offsiteact.meituan.com/act/ge/getUserInfo",
    "https://offsiteact.meituan.com/other",
    "https://passport.meituan.com/account/unitivelogin",
  ])
    assert.throws(() => parseMeituanSession(`curl '${url}' -b 'token=secret'`));
  assert.throws(() =>
    parseMeituanSession(
      "curl 'https://offsiteact.meituan.com/act/ge/getUserInfo",
    ),
  );
});
test("Meituan import rejects malformed, oversized, duplicate or missing cookies", () => {
  for (const input of [
    undefined,
    "",
    "{bad}",
    "{}",
    '{"headers":[]}',
    '{"cookie":123}',
    "token=1\r\nInjected: true",
    "token=1; token=2",
    "token",
    "=value",
    "x".repeat(64_001),
    `token=${"x".repeat(16_001)}`,
    Array(201)
      .fill(0)
      .map((_, i) => `c${i}=1`)
      .join(";"),
  ])
    assert.throws(() => parseMeituanSession(input));
});
test("official login refusals and challenges are classified without exposing private response fields", () => {
  assert.equal(passportRequestIssue(403), "rejected");
  assert.equal(passportRequestIssue(429), "rejected");
  assert.equal(passportRequestIssue(502), "network");
  assert.equal(
    passportRequestIssue(200, {
      error: {
        code: 123,
        message: "请求异常,拒绝操作",
        mobile: "private-phone",
      },
    }),
    "rejected",
  );
  assert.equal(
    passportRequestIssue(200, { error: { request_code: "private-challenge" } }),
    "verification",
  );
  assert.equal(
    passportRequestIssue(200, { error: { message: "验证码错误" } }),
    undefined,
  );
  assert.equal(
    passportRequestIssue(200, { user: { id: 1, token: "secret" } }),
    undefined,
  );
});
