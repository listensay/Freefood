import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { crc32 } from "node:zlib";
import { requestWithHost } from "./fixtures/http";

const directory = await mkdtemp(join(tmpdir(), "food-api-"));
const wechatDirectory = await mkdtemp(join(tmpdir(), "food-api-wechat-"));
const port = 19000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["--import", join(process.cwd(), "tests/fixtures/waimai-upstream.mjs"), ".output/server/index.mjs"], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    FOOD_ALLOW_LAN: "0",
    PORT: String(port),
    FOOD_DATA_DIR: directory,
    FOOD_WECHAT_DATA_DIR: wechatDirectory,
  },
  stdio: "pipe",
});
let output = "";
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Production server failed to start: ${output}`);
  const init = await fetch(`${base}/api/dashboard`);
  let cookie = init.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(init.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(init.headers.get("set-cookie")!, /SameSite=Strict/i);
  const other = await fetch(`${base}/api/dashboard`);
  const cookie2 = other.headers.get("set-cookie")!.split(";")[0]!;
  const call = (
    path: string,
    body?: unknown,
    method = "POST",
    userCookie = cookie,
    extra = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        cookie: userCookie,
        "x-food-request": "1",
        "content-type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const freshCookie = async () => (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
  const setWeChatAppStorage = async (appId: string, values: Record<string, unknown>) => {
    const storage = join(wechatDirectory, "a".repeat(32), "applet/local", appId, "usrmmkvstorage0");
    const encodeVarint = (value: number) => {
      const bytes: number[] = [];
      do { const low = value % 128; value = Math.floor(value / 128); bytes.push(low | (value ? 128 : 0)); } while (value);
      return Buffer.from(bytes);
    };
    const encodeEntry = (key: string, data: unknown) => {
      const name = Buffer.from(key), json = Buffer.from(JSON.stringify({ data, dataType: typeof data === "string" ? "String" : "Object" }));
      const wrapped = Buffer.concat([encodeVarint(json.length), json]);
      return Buffer.concat([encodeVarint(name.length), name, encodeVarint(wrapped.length), wrapped]);
    };
    const plain = Buffer.concat([Buffer.alloc(4), ...Object.entries(values).map(([key, value]) => encodeEntry(key, value))]);
    const key = Buffer.alloc(16);
    Buffer.from("w" + appId.slice(2).split("").filter((_, i) => !(i % 2)).join("")).copy(key);
    const iv = randomBytes(16), cipher = createCipheriv("aes-128-cfb", key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const main = Buffer.alloc(4 + encrypted.length); main.writeUInt32LE(encrypted.length); encrypted.copy(main, 4);
    const metadata = Buffer.alloc(40); metadata.writeUInt32LE(crc32(encrypted)); metadata.writeUInt32LE(4, 4);
    metadata.writeUInt32LE(1, 8); iv.copy(metadata, 12); metadata.writeUInt32LE(encrypted.length, 28);
    await mkdir(storage, { recursive: true });
    await writeFile(join(storage, appId), main); await writeFile(join(storage, appId + ".crc"), metadata);
  };
  const setWeChatStorage = async (accessToken = "wechat-test-success") => {
    const user = {
      silkId: 123456789, userInfo: { silk_id: 123456789, user_id: 6789, phone: "13800000000" },
      wechat_user_info: { user_id: 6789 },
      token: { access_token: accessToken, refresh_token: "private-wechat-refresh", created: Math.floor(Date.now() / 1000), expiry: Math.floor(Date.now() / 1000) + 3600 },
    };
    await setWeChatAppStorage("wx52ae177248081591", {
      store_user: JSON.stringify(user), baseUrl: "https://gw.xiaocantech.com",
      sessionId: JSON.stringify({ expire: Math.floor(Date.now() / 1000) + 1800, value: "private-wechat-session-id" }),
    });
  };
  const waimaiUserId = "b64c312a1c6b4a74b72668f0cab713aa";
  const waimaiUid = "123456789012345678";
  const waimaiProfile = { userId: waimaiUid, nickname: "歪麦测试用户", avatar: "https://example.com/waimai-avatar.png", phone: "138****0000" };
  const setWaimaiStorage = async (token = "wechat-waimai-test-success", userId = waimaiUserId, uid = waimaiUid) => {
    await setWeChatAppStorage("wx5762f23d920ad9e5", {
      token,
      value: { userId, uid, userToken: token, application: "overbear_one", nickName: "歪麦测试用户", avatarUrl: "https://example.com/waimai-avatar.png", phoneNumber: "13800000000", status: true },
    });
  };
  const seedSession = async (snapshot: Record<string, any>) => {
    const id = randomBytes(32).toString("hex"), iv = randomBytes(12);
    const key = await readFile(join(directory, "session.key"));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
    await writeFile(join(directory, `${id}.enc`), Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
    return `food-session=${id}`;
  };
  const nativeXiaochan = async (c: string, token = "corrected-xiaochan-test-session") => {
    const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    snapshot.xiaochanAccount = {
      silkId: "123456789", userId: "6789", accessToken: token,
      refreshToken: "private-refresh-token", expiresAt: Date.now() + 3600_000,
    };
    snapshot.connections.xiaochan = { state: "connected", label: "已登录", profile: { userId: "6789", phone: "138****0000" } };
    return seedSession(snapshot);
  };
  const seededWaimai = async (c: string, token = "wechat-waimai-test-success") => {
    const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    snapshot.waimaiAccount = { userId: waimaiUserId, uid: waimaiUid, token };
    snapshot.connections.waimai = { state: "connected", label: "已登录", profile: waimaiProfile };
    return seedSession(snapshot);
  };
  await test("production page loads and API contains no raw session fields", async () => {
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("cache-control"), "no-store");
    const data = await init.json();
    assert.equal(data.xiaochanHeaders, undefined);
    assert.equal(data.xiaochanAccount, undefined);
    assert.equal(data.waimaiToken, undefined);
    assert.equal(data.waimaiAccount, undefined);
    assert.equal(data.meituanStorage, undefined);
    assert.equal(data.location, null);
    assert.deepEqual(data.offers, { xiaochan: [], waimai: [], meituan: [] });
  });
  await test("homepage keeps synchronization without the activity availability switch", async () => {
    const html = await (await fetch(base)).text();
    assert.match(html, /同步活动/);
    assert.doesNotMatch(html, /仅看有效活动|role="switch"/);
  });
  for (const [path, title, content] of [
    ["/", "叠个饭 · 霸王餐与试吃官同店比价", /7 公里内匹配活动/],
    ["/accounts", "账号管理 · 叠个饭", /连接电脑微信/],
    ["/guide", "使用指南 · 叠个饭", /连接账号后，在首页同步活动并报名小蚕活动。/],
  ] as const) {
    await test(`${path} renders its page and active navigation on direct access`, async () => {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes(`<title>${title}</title>`));
      assert.match(html, content);
      const nav = html.match(/<nav\b[^>]*aria-label="主导航"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
      assert.ok(nav, "Main navigation is missing");
      for (const target of ["/", "/accounts", "/guide"])
        assert.ok(nav.includes(`href="${target}"`));
      const activeLinks = [...nav.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)];
      assert.equal(activeLinks.length, 1);
      assert.ok(activeLinks[0]![0].includes(`href="${path}"`));
      if (path === "/accounts")
        assert.doesNotMatch(html, /活动导入|同步活动|type="file"|xiaochan-phone|xiaochan-password|手机号登录|小程序会话导入|启用访客访问|waimai-token|打开登录页面|浏览器登录|meituan-session|请求头 JSON/);
    });
  }
  await test("unknown page routes return 404", async () => {
    assert.equal((await fetch(base + "/missing-page")).status, 404);
  });
  await test("cross-origin and missing-header mutations are rejected", async () => {
    assert.equal(
      (
        await call("/api/location", {}, "POST", cookie, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/import", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
  });
  await test("local mode rejects private and public Host headers without trusting forwarded hosts", async () => {
    for (const host of ["192.168.1.20", "8.8.8.8", "evil.example"])
      assert.equal((await requestWithHost(base + "/api/dashboard", {
        headers: { host: `${host}:${port}`, "x-forwarded-host": `localhost:${port}` },
      })).status, 403);
  });
  await test("Unsupported password and header login cannot create a Xiaochan account", async () => {
    for (const body of [{ phone: "13800000000", password: "private-test-secret" }, { session: '{"token":"fake"}' }]) {
      const r = await call("/api/connections/xiaochan", body);
      assert.equal(r.status, 404);
    }
    const data = await (await fetch(base + "/api/dashboard", { headers: { cookie } })).json();
    assert.equal(data.connections.xiaochan.state, "disconnected");
  });
  await test("Stored verified Xiaochan sessions keep credentials encrypted and private", async () => {
    cookie = await nativeXiaochan(cookie);
    const r = await fetch(base + "/api/dashboard", { headers: { cookie } });
    const text = await r.text(), data = JSON.parse(text);
    for (const secret of ["corrected-xiaochan-test-session", "private-refresh-token"])
      assert.ok(!text.includes(secret));
    assert.equal(data.connections.xiaochan.state, "connected");
    assert.equal(data.connections.xiaochan.profile.userId, "6789");
    assert.equal(data.xiaochanAccount, undefined);
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".enc")))
      assert.ok(!(await readFile(join(directory, name))).includes(Buffer.from("corrected-xiaochan-test-session")));
  });
  await test("Computer WeChat connection requires no supplied credentials and does not read caller paths", async () => {
    const c = await freshCookie();
    for (const body of ["text", [], { path: "/tmp/private-path" }, { accessToken: "private-token" }, { session: "headers" }])
      assert.equal((await call("/api/connections/xiaochan/wechat", body, "POST", c)).status, 400);
    assert.equal((await call("/api/connections/xiaochan/wechat", {}, "POST", c)).status, 404);
    const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    assert.equal(saved.connections.xiaochan.state, "disconnected");
    assert.equal((await call("/api/connections/xiaochan/wechat", {}, "POST", c, { origin: "https://evil.example" })).status, 403);
    const withoutHeader = await fetch(base + "/api/connections/xiaochan/wechat", {
      method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(withoutHeader.status, 403);
  });
  await test("Computer WeChat connection verifies the decrypted mini-program session and preserves other platforms", async () => {
    const c = await freshCookie();
    await call("/api/import", { provider: "waimai", offers: [{ id: "wechat-other", name: "测试店", rule: { kind: "fixed", thresholdCents: 2500, cashbackCents: 2000 } }] }, "POST", c);
    await setWeChatStorage();
    const response = await call("/api/connections/xiaochan/wechat", {}, "POST", c);
    assert.equal(response.status, 200);
    const text = await response.text(), data = JSON.parse(text);
    assert.equal(data.connections.xiaochan.state, "connected");
    assert.equal(data.connections.xiaochan.label, "已登录");
    assert.deepEqual(data.connections.xiaochan.profile, {
      userId: "6789", nickname: "测试用户", avatar: "https://example.com/xiaochan-avatar.png", phone: "138****0000",
    });
    assert.equal(data.offers.waimai[0].id, "waimai:wechat-other");
    for (const secret of ["wechat-test-success", "private-wechat-refresh", "private-wechat-session-id", "private-profile-field"])
      assert.ok(!text.includes(secret));
    assert.equal(data.xiaochanAccount, undefined);
    const id = c.split("=")[1]!;
    const encrypted = await readFile(join(directory, id + ".enc"));
    assert.ok(!encrypted.includes(Buffer.from("wechat-test-success")));
    const key = await readFile(join(directory, "session.key"));
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    const local = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString());
    assert.equal(local.xiaochanAccount.platform, "mini");
    assert.equal(local.xiaochanHeaders, undefined);
    const otherBrowser = await (await fetch(base + "/api/dashboard", { headers: { cookie: cookie2 } })).json();
    assert.equal(otherBrowser.connections.xiaochan.state, "disconnected");
    await call("/api/location", { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 }, "POST", c);
    const sync = await (await call("/api/sync", { provider: "xiaochan" }, "POST", c)).json();
    assert.deepEqual(sync.errors, []);
    assert.equal(sync.data.offers.xiaochan[0].id, "xiaochan:42");
    assert.deepEqual(sync.data.connections.xiaochan.profile, data.connections.xiaochan.profile);
    const enroll = await call("/api/xiaochan/enroll", { offerId: "xiaochan:43" }, "POST", c);
    assert.equal(enroll.status, 200);
    assert.equal((await enroll.json()).offers.xiaochan.find((offer: any) => offer.id === "xiaochan:43").enrollment.orderId, "9043");
  });
  for (const [token, expected] of [["wechat-test-mismatched-user", 401], ["wechat-test-mismatched-silk", 401], ["wechat-test-logoff", 401], ["wechat-test-expired", 401], ["wechat-test-network-failure", 502]] as const) {
    await test(`Computer WeChat ${token} never overwrites a previous verified session`, async () => {
      const c = await nativeXiaochan(await freshCookie());
      const row = { id: "wechat-existing", name: "测试店", rule: { kind: "fixed", thresholdCents: 2500, cashbackCents: 2000 } };
      await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
      await setWeChatStorage(token);
      const response = await call("/api/connections/xiaochan/wechat", {}, "POST", c);
      assert.equal(response.status, expected);
      assert.ok(!(await response.text()).includes("private-WeChat-upstream-error"));
      const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      assert.equal(saved.connections.xiaochan.state, "connected");
      assert.equal(saved.connections.xiaochan.profile.userId, "6789");
      assert.equal(saved.offers.xiaochan[0].id, "xiaochan:wechat-existing");
    });
  }
  await test("synchronization requires a user-provided location", async () => {
    const response = await call("/api/sync");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).statusMessage, "请先设置收餐地址");
  });
  await test("Removed Waimai import endpoint cannot accept tokens or enable guest access", async () => {
    for (const body of [{ token: "api-private-waimai-token" }, { token: "" }, {}])
      assert.equal((await call("/api/connections/waimai", body)).status, 404);
    assert.equal((await call("/api/sync", { provider: "unknown" })).status, 400);
    const data = await (await fetch(base + "/api/dashboard", { headers: { cookie } })).json();
    assert.equal(data.connections.waimai.state, "disconnected");
  });
  await test("Waimai computer WeChat connection rejects supplied credentials and requires a local login", async () => {
    const c = await freshCookie();
    for (const body of ["text", [], { path: "/tmp/private-path" }, { token: "private-token" }, { session: "headers" }])
      assert.equal((await call("/api/connections/waimai/wechat", body, "POST", c)).status, 400);
    assert.equal((await call("/api/connections/waimai/wechat", {}, "POST", c)).status, 404);
    assert.equal((await call("/api/connections/waimai/wechat", {}, "POST", c, { origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(base + "/api/connections/waimai/wechat", {
      method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: "{}",
    })).status, 403);
  });
  await test("Waimai computer WeChat verifies identity and returns only basic user information", async () => {
    await setWaimaiStorage();
    const response = await call("/api/connections/waimai/wechat", {});
    assert.equal(response.status, 200);
    const text = await response.text(), data = JSON.parse(text);
    assert.equal(data.connections.waimai.state, "connected");
    assert.equal(data.connections.waimai.label, "已登录");
    assert.deepEqual(data.connections.waimai.profile, waimaiProfile);
    assert.equal(data.connections.xiaochan.state, "connected");
    assert.equal(data.waimaiAccount, undefined);
    for (const secret of ["wechat-waimai-test-success", "private-waimai-profile-field"])
      assert.ok(!text.includes(secret));
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".enc")))
      assert.ok(!(await readFile(join(directory, name))).includes(Buffer.from("wechat-waimai-test-success")));
    const isolated = await (await fetch(base + "/api/dashboard", { headers: { cookie: cookie2 } })).json();
    assert.equal(isolated.connections.waimai.state, "disconnected");
  });
  const row = {
    id: "001",
    name: "API 测试（同一分店）",
    meituanPoiId: "1122",
    rule: { kind: "fixed", thresholdCents: 2500, cashbackCents: 2000 },
  };
  await test("imports persist valid normalized offers without authenticating provider", async () => {
    assert.equal(
      (await call("/api/import", { provider: "xiaochan", offers: [row] }))
        .status,
      200,
    );
    const r = await call("/api/import", {
      provider: "meituan",
      offers: [
        {
          ...row,
          rule: {
            kind: "percentage",
            thresholdCents: 0,
            ratioBps: 3000,
            capCents: 1000,
          },
        },
      ],
    });
    const d = await r.json();
    assert.equal(d.offers.meituan.length, 1);
    assert.equal(d.connections.meituan.state, "disconnected");
    assert.equal(d.offers.meituan[0].source, "import");
    assert.equal(
      (
        await call("/api/import", {
          provider: "xiaochan",
          offers: [{ ...row, rule: { ...row.rule, cashbackCents: -10 } }],
        })
      ).status,
      400,
    );
  });
  await test("Waimai import preserves other providers and normalizes IDs", async () => {
    const d = await (await call("/api/import", { provider: "waimai", offers: [row] })).json();
    assert.equal(d.offers.waimai[0].id, "waimai:001");
    assert.equal(d.offers.waimai[0].source, "import");
    assert.equal(d.offers.xiaochan.length, 1);
    assert.equal(d.offers.meituan.length, 1);
  });
  await test("different browser sessions never share credentials or imported offers", async () => {
    const r = await fetch(base + "/api/dashboard", {
      headers: { cookie: cookie2 },
    });
    const d = await r.json();
    assert.equal(d.offers.xiaochan.length, 0);
    assert.equal(d.connections.xiaochan.state, "disconnected");
    assert.equal(d.connections.waimai.state, "disconnected");
    assert.equal(d.offers.waimai.length, 0);
  });
  await test("legacy two-provider sessions gain Waimai without losing existing offers or accounts", async () => {
    const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie } })).json();
    delete snapshot.connections.waimai;
    delete snapshot.offers.waimai;
    snapshot.xiaochanAccount = { silkId: "123456789", userId: "6789", accessToken: "corrected-xiaochan-test-session", expiresAt: Date.now() + 3600_000 };
    const id = randomBytes(32).toString("hex"), iv = randomBytes(12);
    const key = await readFile(join(directory, "session.key"));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
    await writeFile(join(directory, `${id}.enc`), Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
    const d = await (await fetch(base + "/api/dashboard", { headers: { cookie: `food-session=${id}` } })).json();
    assert.deepEqual(d.offers.waimai, []);
    assert.equal(d.connections.waimai.state, "disconnected");
    assert.equal(d.connections.xiaochan.state, "connected");
    assert.equal(d.offers.xiaochan.length, 1);
    assert.equal(d.offers.meituan.length, 1);
  });
  await test("stored obsolete activities are removed without deleting imported data", async () => {
    const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie } })).json();
    snapshot.offers.xiaochan.push({
      ...snapshot.offers.xiaochan[0], id: "obsolete-activity", source: "legacy",
    });
    const id = randomBytes(32).toString("hex"), iv = randomBytes(12);
    const key = await readFile(join(directory, "session.key"));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
    const path = join(directory, `${id}.enc`);
    await writeFile(path, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
    const response = await fetch(base + "/api/dashboard", { headers: { cookie: `food-session=${id}` } });
    const data = await response.json();
    assert.equal(data.offers.xiaochan.length, 1);
    assert.equal(data.offers.xiaochan[0].source, "import");
    assert.equal(data.offers.meituan.length, 1);
    const saved = await readFile(path);
    const decipher = createDecipheriv("aes-256-gcm", key, saved.subarray(0, 12));
    decipher.setAuthTag(saved.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(saved.subarray(28)), decipher.final()]).toString();
    assert.ok(!plaintext.includes("obsolete-activity"));
  });
  await test("location change clears all previous-location offers but keeps connections", async () => {
    const r = await call("/api/location", {
      label: "上海",
      cityCode: 310000,
      cityName: "上海市",
      latitude: 31.23,
      longitude: 121.47,
    });
    const d = await r.json();
    assert.equal(d.offers.xiaochan.length, 0);
    assert.equal(d.offers.meituan.length, 0);
    assert.equal(d.offers.waimai.length, 0);
    assert.equal(d.location.cityName, "上海市");
    assert.equal(d.connections.xiaochan.state, "connected");
  });
  await test("selected Waimai synchronization leaves Xiaochan untouched and enforces cooldown", async () => {
    await call("/api/import", { provider: "xiaochan", offers: [row] });
    const r = await call("/api/sync", { provider: "waimai" });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.waimai.length, 1);
    assert.equal(result.data.offers.waimai[0].rule.cashbackCents, 2000);
    assert.equal(result.data.offers.waimai[0].source, "live");
    assert.equal(result.data.offers.xiaochan[0].source, "import");
    assert.equal(result.data.connections.waimai.state, "connected");
    assert.deepEqual(result.data.connections.waimai.profile, waimaiProfile);
    assert.equal(result.data.waimaiAccount, undefined);
    assert.equal((await call("/api/sync", { provider: "waimai" })).status, 429);
  });
  await test("Switching providers can immediately sync Waimai while Xiaochan retains its own cooldown", async () => {
    const snapshot = await (await fetch(base + "/api/dashboard")).json();
    snapshot.xiaochanAccount = { silkId: "123456789", userId: "6789", accessToken: "corrected-xiaochan-test-session" };
    snapshot.waimaiAccount = { userId: waimaiUserId, uid: waimaiUid, token: "wechat-waimai-test-success" };
    snapshot.connections.xiaochan = { state: "connected", label: "已登录" };
    snapshot.connections.waimai = { state: "connected", label: "已登录" };
    snapshot.location = { label: "南宁", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 };
    const both = await seedSession(snapshot);
    const xiaochan = await call("/api/sync", { provider: "xiaochan" }, "POST", both);
    assert.equal(xiaochan.status, 200);
    const previous = (await xiaochan.json()).data;
    const waimai = await call("/api/sync", { provider: "waimai" }, "POST", both);
    assert.equal(waimai.status, 200);
    const result = await waimai.json();
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.waimai.length, 1);
    assert.deepEqual(result.data.offers.xiaochan, previous.offers.xiaochan);
    assert.equal((await call("/api/sync", { provider: "waimai" }, "POST", both)).status, 429);
    assert.equal((await call("/api/sync", { provider: "xiaochan" }, "POST", both)).status, 429);
  });
  await test("A completed Waimai sync is saved before another platform finishes", async () => {
    const snapshot = await (await fetch(base + "/api/dashboard")).json();
    snapshot.xiaochanAccount = { silkId: "123456789", userId: "6789", accessToken: "wechat-test-slow-sync", platform: "mini" };
    snapshot.waimaiAccount = { userId: waimaiUserId, uid: waimaiUid, token: "wechat-waimai-test-success" };
    snapshot.connections.xiaochan = { state: "connected", label: "已登录" };
    snapshot.connections.waimai = { state: "connected", label: "已登录" };
    snapshot.location = { label: "南宁", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 };
    const c = await seedSession(snapshot);
    let finished = false;
    const syncing = call("/api/sync", {}, "POST", c).then(response => { finished = true; return response.json(); });
    let data: any;
    for (let i = 0; i < 20; i++) {
      data = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      if (data.offers.waimai.length) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(data.offers.waimai.length, 1);
    assert.equal(data.offers.xiaochan.length, 0);
    assert.equal(finished, false);
    const result = await syncing;
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.waimai.length, 1);
    assert.equal(result.data.offers.xiaochan.length, 1);
  });
  await test("A running Xiaochan sync does not block a separate Waimai sync", async () => {
    const snapshot = await (await fetch(base + "/api/dashboard")).json();
    snapshot.xiaochanAccount = { silkId: "123456789", userId: "6789", accessToken: "wechat-test-slow-sync", platform: "mini" };
    snapshot.waimaiAccount = { userId: waimaiUserId, uid: waimaiUid, token: "wechat-waimai-test-success" };
    snapshot.connections.xiaochan = { state: "connected", label: "已登录" };
    snapshot.connections.waimai = { state: "connected", label: "已登录" };
    snapshot.location = { label: "南宁", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 };
    const c = await seedSession(snapshot);
    let finished = false;
    const pending = call("/api/sync", { provider: "xiaochan" }, "POST", c).then(response => { finished = true; return response.json(); });
    await new Promise(resolve => setTimeout(resolve, 100));
    const waimai = await call("/api/sync", { provider: "waimai" }, "POST", c);
    assert.equal(waimai.status, 200);
    assert.equal((await waimai.json()).data.offers.waimai.length, 1);
    assert.equal(finished, false);
    const result = await pending;
    assert.equal(result.data.offers.waimai.length, 1);
  });
  await test("Combination tabs only switch cached results, without starting or queuing syncs; manual and timed sync use the selected tab", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      for (const inFlight of [false, true]) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.clock.install();
        const collectedAt = new Date().toISOString();
        const activity = { category: "美食", inventory: 3, distanceMeters: 1000, requirement: "无需评价",
          source: "live", collectedAt, rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 } };
        const waimai = { ...activity, provider: "waimai", id: "waimai:store:sku", name: "歪麦测试（同一分店）" };
        const dashboard: any = {
          location: { label: "南宁", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
          connections: {
            xiaochan: { state: "connected", label: "已登录", profile: { userId: "1" } },
            waimai: { state: "connected", label: "已登录", profile: { userId: "2" } },
            meituan: { state: "disconnected", label: "未连接" },
          },
          offers: { xiaochan: [], waimai: [waimai], meituan: [{ ...waimai, provider: "meituan", id: "meituan:1" }] },
          updatedAt: {}, enrollmentSchedules: [],
        };
        const requested: string[] = [];
        let completeFirst: (() => Promise<void>) | undefined;
        await page.route("**/api/**", async route => {
          if (route.request().url().endsWith("/api/sync")) {
            const { provider } = route.request().postDataJSON();
            requested.push(provider);
            if (inFlight && requested.length === 1) {
              completeFirst = () => route.fulfill({ json: { data: dashboard, errors: [], message: "同步完成" } });
              return;
            }
            await route.fulfill({ json: { data: dashboard, errors: [], message: "同步完成" } });
          } else await route.fulfill({ json: dashboard });
        });
        const firstRequest = page.waitForRequest(request => request.url().endsWith("/api/sync"));
        await page.goto(base);
        await firstRequest;
        if (!inFlight) await page.waitForFunction(() => !document.querySelector(".sync-button")?.textContent?.includes("正在同步"));
        await page.getByRole("button", { name: "歪麦", exact: true }).click();
        await page.locator(".store-card").waitFor();
        await page.clock.runFor(100);
        assert.deepEqual(requested, ["xiaochan"]);
        assert.equal(await page.evaluate(() => localStorage.getItem("food-bawangcan-provider")), "waimai");
        assert.equal(await page.getByRole("button", { name: "歪麦", exact: true }).getAttribute("aria-pressed"), "true");
        if (inFlight) {
          assert.match(await page.locator(".sync-button").innerText(), /正在同步/);
          await completeFirst!();
        }
        await page.waitForFunction(() => !document.querySelector(".sync-button")?.textContent?.includes("正在同步"));
        await page.getByRole("button", { name: "歪麦", exact: true }).click();
        await page.getByRole("button", { name: "小蚕", exact: true }).click();
        await page.getByRole("button", { name: "歪麦", exact: true }).click();
        await page.clock.runFor(100);
        assert.deepEqual(requested, ["xiaochan"]);
        assert.equal(await page.locator(".store-card h3").innerText(), waimai.name);
        assert.equal(await page.locator(".store-card .match-status").count(), 0);
        assert.doesNotMatch(await page.locator(".store-card").innerText(), /分店待核验/);
        const manualSync = page.waitForResponse(response => response.url().endsWith("/api/sync"));
        await page.getByRole("button", { name: "同步活动", exact: true }).click();
        await manualSync;
        await page.waitForFunction(() => !document.querySelector(".sync-button")?.textContent?.includes("正在同步"));
        assert.deepEqual(requested, ["xiaochan", "waimai"]);
        const timedSync = page.waitForResponse(response => response.url().endsWith("/api/sync"));
        await page.clock.fastForward(5 * 60_000);
        await timedSync;
        assert.deepEqual(requested, ["xiaochan", "waimai", "waimai"]);
        await context.close();
      }
    } finally { await browser.close(); }
  });
  await test("Page navigation and history never start or queue syncs; manual and homepage timed sync remain available", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      for (const inFlight of [false, true]) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.clock.install();
        const dashboard = {
          location: { label: "南宁", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
          connections: {
            xiaochan: { state: "connected", label: "已登录", profile: { userId: "1" } },
            waimai: { state: "disconnected", label: "未连接" },
            meituan: { state: "disconnected", label: "未连接" },
          },
          offers: { xiaochan: [], waimai: [], meituan: [] }, updatedAt: {}, enrollmentSchedules: [],
        };
        let syncs = 0;
        let completeFirst: (() => Promise<void>) | undefined;
        await page.route("**/api/**", async route => {
          if (!route.request().url().endsWith("/api/sync")) return route.fulfill({ json: dashboard });
          const complete = () => route.fulfill({ json: { data: dashboard, errors: [], message: "同步完成" } });
          if (++syncs === 1 && inFlight) { completeFirst = complete; return; }
          await complete();
        });
        const firstRequest = page.waitForRequest(request => request.url().endsWith("/api/sync"));
        await page.goto(base);
        await firstRequest;
        if (!inFlight) await page.getByRole("button", { name: "同步活动", exact: true }).waitFor();
        const navigate = async (name: string, path: string) => {
          await page.getByRole("link", { name, exact: true }).click();
          await page.waitForURL(base + path);
          await page.clock.runFor(100);
          assert.equal(syncs, 1);
        };
        await navigate("账号管理", "/accounts");
        await navigate("返回首页", "/");
        await navigate("使用指南", "/guide");
        await navigate("首页", "/");
        await page.goBack();
        await page.waitForURL(base + "/guide");
        await page.clock.runFor(100);
        assert.equal(syncs, 1);
        await page.goForward();
        await page.waitForURL(base + "/");
        await page.clock.runFor(100);
        assert.equal(syncs, 1);
        if (inFlight) {
          assert.match(await page.locator(".sync-button").innerText(), /正在同步/);
          await completeFirst!();
        }
        await page.getByRole("button", { name: "同步活动", exact: true }).waitFor();
        await navigate("使用指南", "/guide");
        await page.clock.fastForward(5 * 60_000);
        assert.equal(syncs, 1);
        await navigate("叠个饭首页", "/");
        const manualSync = page.waitForResponse(response => response.url().endsWith("/api/sync"));
        await page.getByRole("button", { name: "同步活动", exact: true }).click();
        await manualSync;
        await page.getByRole("button", { name: "同步活动", exact: true }).waitFor();
        assert.equal(syncs, 2);
        const timedSync = page.waitForResponse(response => response.url().endsWith("/api/sync"));
        await page.clock.fastForward(5 * 60_000);
        await timedSync;
        assert.equal(syncs, 3);
        await context.close();
      }
    } finally { await browser.close(); }
  });
  await test("Successful automatic synchronization clears its old error while preserving other action errors", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      await page.clock.install();
      const dashboard = {
        location: { label: "南宁", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
        connections: {
          xiaochan: { state: "connected", label: "已登录", profile: { userId: "1" } },
          waimai: { state: "disconnected", label: "未连接" },
          meituan: { state: "disconnected", label: "未连接" },
        },
        offers: { xiaochan: [], waimai: [], meituan: [] }, updatedAt: {}, enrollmentSchedules: [],
      };
      let syncs = 0;
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/sync") return route.fulfill({ json: {
          data: dashboard, errors: ++syncs === 1 ? ["小蚕请求被拦截，请稍后重试"] : [], message: "同步完成",
        } });
        if (path === "/api/connections/waimai/wechat") return route.fulfill({
          status: 502, json: { statusMessage: "歪麦连接失败" },
        });
        return route.fulfill({ json: dashboard });
      });
      await page.goto(base);
      await page.getByRole("alert").getByText("小蚕请求被拦截，请稍后重试", { exact: true }).waitFor();
      await page.clock.fastForward(5 * 60_000);
      await page.getByRole("alert").waitFor({ state: "hidden" });
      assert.equal(syncs, 2);
      await page.getByRole("link", { name: "账号管理", exact: true }).click();
      await page.locator(".account-panel").filter({ has: page.getByRole("heading", { name: "歪麦霸王餐", exact: true }) })
        .getByRole("button", { name: "连接电脑微信", exact: true }).click();
      await page.getByRole("alert").getByText("歪麦连接失败", { exact: true }).waitFor();
      await page.getByRole("link", { name: "返回首页", exact: true }).click();
      await page.locator(".sync-button").waitFor();
      await page.clock.runFor(100);
      assert.equal(syncs, 2);
      const nextSync = page.waitForResponse(response => response.url().endsWith("/api/sync"));
      await page.clock.fastForward(5 * 60_000);
      await nextSync;
      await page.waitForFunction(() => !document.querySelector(".sync-button")?.textContent?.includes("正在同步"));
      assert.equal(syncs, 3);
      assert.match(await page.getByRole("alert").innerText(), /歪麦连接失败/);
    } finally { await browser.close(); }
  });
  await test("Waimai synchronization requires login and a city name", async () => {
    const anonymous = await freshCookie();
    await call("/api/location", { label: "收餐地址", cityName: "上海市", cityCode: 310000, latitude: 31.23, longitude: 121.47 }, "POST", anonymous);
    assert.equal((await call("/api/sync", { provider: "waimai" }, "POST", anonymous)).status, 400);
    const c = await seededWaimai(await freshCookie());
    await call("/api/location", { label: "收餐地址", cityCode: 310000, latitude: 31.23, longitude: 121.47 }, "POST", c);
    assert.equal((await call("/api/sync", { provider: "waimai" }, "POST", c)).status, 400);
    await call("/api/location", { label: "收餐地址", cityName: "上海市", cityCode: 310000, latitude: 31.23, longitude: 121.47 }, "POST", c);
    const result = await (await call("/api/sync", { provider: "waimai" }, "POST", c)).json();
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.waimai.length, 1);
    assert.equal(result.data.connections.waimai.state, "connected");
    assert.deepEqual(result.data.connections.waimai.profile, waimaiProfile);
  });
  await test("Waimai reconnection preserves activities for the same account and clears them on account changes", async () => {
    const c = await seededWaimai(await freshCookie());
    await call("/api/import", { provider: "waimai", offers: [row] }, "POST", c);
    await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
    await setWaimaiStorage();
    const same = await call("/api/connections/waimai/wechat", {}, "POST", c);
    assert.equal(same.status, 200);
    const kept = await same.json();
    assert.equal(kept.offers.waimai[0].id, "waimai:001");
    assert.deepEqual(kept.connections.waimai.profile, waimaiProfile);
    await setWaimaiStorage("wechat-waimai-test-success", "b64c312a1c6b4a74b72668f0cab713ab");
    const rotated = await call("/api/connections/waimai/wechat", {}, "POST", c);
    assert.equal(rotated.status, 200);
    const continued = await rotated.json();
    assert.equal(continued.offers.waimai[0].id, "waimai:001");
    assert.deepEqual(continued.connections.waimai.profile, waimaiProfile);
    await setWaimaiStorage("wechat-waimai-test-success", "b64c312a1c6b4a74b72668f0cab713ac", "223456789012345678");
    const changed = await call("/api/connections/waimai/wechat", {}, "POST", c);
    assert.equal(changed.status, 200);
    const data = await changed.json();
    assert.deepEqual(data.offers.waimai, []);
    assert.equal(data.updatedAt.waimai, undefined);
    assert.equal(data.connections.waimai.profile.userId, "223456789012345678");
    assert.equal(data.offers.xiaochan[0].id, "xiaochan:001");
  });
  for (const [token, expected] of [["wechat-waimai-test-expired", 401], ["wechat-waimai-test-network-failure", 502], ["wechat-waimai-test-mismatched-user", 401], ["wechat-waimai-test-wrong-application", 401]] as const) {
    await test(`Waimai ${token} never overwrites a previous verified account or activities`, async () => {
      const c = await seededWaimai(await freshCookie());
      await call("/api/import", { provider: "waimai", offers: [row] }, "POST", c);
      await setWaimaiStorage(token);
      const response = await call("/api/connections/waimai/wechat", {}, "POST", c);
      assert.equal(response.status, expected);
      const text = await response.text();
      assert.ok(!text.includes("private-waimai-network-error"));
      assert.ok(!text.includes(token));
      const data = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      assert.equal(data.connections.waimai.state, "connected");
      assert.deepEqual(data.connections.waimai.profile, waimaiProfile);
      assert.equal(data.offers.waimai[0].id, "waimai:001");
    });
  }
  for (const token of ["expired-test-token", "network-failure-token", "verification-test-token"]) {
    await test(`Waimai ${token} preserves the last successful dataset`, async () => {
      const c = await seededWaimai(await freshCookie(), token);
      await call("/api/location", { label: "收餐地址", cityName: "上海市", cityCode: 310000, latitude: 31.23, longitude: 121.47 }, "POST", c);
      await call("/api/import", { provider: "waimai", offers: [row] }, "POST", c);
      const result = await (await call("/api/sync", { provider: "waimai" }, "POST", c)).json();
      assert.equal(result.errors.length, 1);
      assert.equal(result.data.offers.waimai[0].id, "waimai:001");
      assert.equal(result.data.connections.waimai.state, token === "expired-test-token" ? "expired" : "connected");
      if (token === "verification-test-token")
        assert.deepEqual(result.errors, ["请在电脑微信的歪麦小程序中完成验证后重试"]);
    });
  }
  await test("disconnecting Waimai clears only its credentials and activities", async () => {
    const response = await call("/api/connections/waimai", undefined, "DELETE");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.connections.waimai.state, "disconnected");
    assert.equal(data.connections.waimai.profile, undefined);
    assert.deepEqual(data.offers.waimai, []);
    assert.equal(data.updatedAt.waimai, undefined);
    assert.equal(data.connections.xiaochan.state, "connected");
    assert.equal(data.offers.xiaochan.length, 1);
  });
  await test("disconnect removes credentials and unknown provider is rejected", async () => {
    const r = await call("/api/connections/xiaochan", undefined, "DELETE");
    assert.equal((await r.json()).connections.xiaochan.state, "disconnected");
    assert.equal(
      (await call("/api/connections/not-a-provider", undefined, "DELETE"))
        .status,
      400,
    );
  });
  await test("Unavailable login preserves existing credentials and activities", async () => {
    const c = await nativeXiaochan(await freshCookie());
    await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
    for (const body of [undefined, { session: "x-teemo: 1" }, { phone: "13800000000", password: "password" }])
      assert.equal((await call("/api/connections/xiaochan", body, "POST", c)).status, 404);
    const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    assert.equal(saved.connections.xiaochan.state, "connected");
    assert.equal(saved.offers.xiaochan[0].id, "xiaochan:001");
  });
  await test("first automatic location preserves imports while subsequent location changes clear them", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
    const address = { automatic: true, label: "南宁市青秀区", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 };
    const first = await (await call("/api/location", address, "POST", c)).json();
    assert.equal(first.location.cityName, "南宁市");
    assert.equal(first.offers.xiaochan[0].id, "xiaochan:001");
    assert.ok(first.updatedAt.xiaochan);
    const second = await (await call("/api/location", { ...address, longitude: 108.37 }, "POST", c)).json();
    assert.deepEqual(second.offers.xiaochan, []);
    assert.equal(second.updatedAt.xiaochan, undefined);
  });
  await test("raw Xiaochan response imports are rejected without modifying existing activities", async () => {
    const c = (await fetch(base + "/api/dashboard")).headers.get("set-cookie")!.split(";")[0]!;
    await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
    for (const offers of [
      { status: { code: 0 }, feed_items: [] },
      { status: { code: 0 }, promotion_list: [] },
    ]) assert.equal((await call("/api/import", { provider: "xiaochan", offers }, "POST", c)).status, 400);
    const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    assert.equal(saved.offers.xiaochan[0].id, "xiaochan:001");
    assert.equal(saved.connections.xiaochan.state, "disconnected");
  });
  await test("Xiaochan synchronization uses the corrected nonce contract and preserves session isolation", async () => {
    let c = (await fetch(base + "/api/dashboard")).headers
      .get("set-cookie")!
      .split(";")[0]!;
    await call(
      "/api/location",
      { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
      "POST",
      c,
    );
    c = await nativeXiaochan(c);
    const response = await call("/api/sync", { provider: "xiaochan" }, "POST", c);
    assert.equal(response.status, 200);
    const text = await response.text(),
      result = JSON.parse(text);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.offers.xiaochan.length, 4);
    assert.equal(result.data.offers.xiaochan[0].source, "live");
    assert.equal(result.data.offers.xiaochan[0].id, "xiaochan:42");
    assert.equal(result.data.connections.xiaochan.state, "connected");
    assert.equal(result.data.connections.xiaochan.label, "已登录");
    assert.equal(result.data.connections.xiaochan.profile.userId, "6789");
    assert.ok(!text.includes("corrected-xiaochan-test-session"));
    assert.equal(
      (await call("/api/sync", { provider: "xiaochan" }, "POST", c)).status,
      429,
    );
  });
  for (const [token, state, message] of [
    [
      "waf-xiaochan-test-session",
      "connected",
      "小蚕请求被拦截，请稍后重试",
    ],
    [
      "blocked-xiaochan-test-session",
      "connected",
      "小蚕拒绝同步请求",
    ],
    [
      "failed-xiaochan-test-session",
      "connected",
      "小蚕活动请求失败，请稍后重试",
    ],
    ["expired-xiaochan-test-session", "expired", "小蚕登录已失效，请重新登录"],
  ]) {
    await test(`Xiaochan ${token} keeps the last dataset and classifies only confirmed expiry`, async () => {
      let c = (await fetch(base + "/api/dashboard")).headers
        .get("set-cookie")!
        .split(";")[0]!;
      await call(
        "/api/location",
        { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
        "POST",
        c,
      );
      c = await nativeXiaochan(c, token);
      await call(
        "/api/import",
        { provider: "xiaochan", offers: [row] },
        "POST",
        c,
      );
      const response = await call(
        "/api/sync",
        { provider: "xiaochan" },
        "POST",
        c,
      );
      assert.equal(response.status, 200);
      const text = await response.text(),
        result = JSON.parse(text);
      assert.deepEqual(result.errors, [message]);
      assert.equal(result.data.connections.xiaochan.state, state);
      assert.equal(result.data.offers.xiaochan[0].id, "xiaochan:001");
      assert.ok(!text.includes("private-upstream-field"));
      assert.ok(!text.includes(token!));
    });
  }
  const enrollmentSession = async (token: string) => {
    const c = await nativeXiaochan(await freshCookie(), token);
    await call("/api/location", { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 }, "POST", c);
    const response = await call("/api/sync", { provider: "xiaochan" }, "POST", c);
    assert.equal(response.status, 200);
    const synced = await response.json();
    assert.deepEqual(synced.errors, []);
    assert.ok(synced.data.offers.xiaochan.some((offer: any) => offer.id === "xiaochan:42"));
    return c;
  };
  await test("Enrollment rejects anonymous, cross-site and missing-header requests", async () => {
    const c = await freshCookie();
    assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, 401);
    assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c, { origin: "https://evil.example" })).status, 403);
    const response = await fetch(base + "/api/xiaochan/enroll", {
      method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify({ offerId: "xiaochan:42" }),
    });
    assert.equal(response.status, 403);
  });
  await test("Enrollment validates live availability and selects the exact tier without claiming a duplicate quota", async () => {
    const c = await enrollmentSession("enroll-success");
    for (const [offerId, expected] of [["xiaochan:99", 404], ["waimai:42", 400], ["xiaochan:0", 400], ["xiaochan:44", 409], ["xiaochan:45", 409]] as const)
      assert.equal((await call("/api/xiaochan/enroll", { offerId }, "POST", c)).status, expected);
    const result = await call("/api/xiaochan/enroll", { offerId: "xiaochan:43" }, "POST", c);
    assert.equal(result.status, 200);
    const text = await result.text(), data = JSON.parse(text);
    assert.deepEqual(data.offers.xiaochan.find((offer: any) => offer.id === "xiaochan:43").enrollment, { state: "enrolled", orderId: "9043" });
    assert.equal(data.offers.xiaochan.find((offer: any) => offer.id === "xiaochan:42").enrollment, undefined);
    assert.ok(!text.includes("enroll-success"));
    assert.equal(data.xiaochanAccount, undefined);
    const repeat = await call("/api/xiaochan/enroll", { offerId: "xiaochan:43" }, "POST", c);
    assert.equal(repeat.status, 200);
    const otherBrowser = await (await fetch(base + "/api/dashboard", { headers: { cookie: cookie2 } })).json();
    assert.ok(!otherBrowser.offers.xiaochan.some((offer: any) => offer.enrollment));
    await call("/api/connections/xiaochan", undefined, "DELETE", c);
    const cleared = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    assert.equal(cleared.connections.xiaochan.state, "disconnected");
    assert.equal(cleared.connections.xiaochan.profile, undefined);
    assert.deepEqual(cleared.offers.xiaochan, []);
  });
  for (const token of ["enroll-sync-cancel", "enroll-sync-failure", "enroll-sync-expired"]) {
    await test(`${token} reconciles phone cancellation while preserving other activity tiers`, async () => {
      const c = await enrollmentSession(token);
      for (const offerId of ["xiaochan:42", "xiaochan:43"])
        assert.equal((await call("/api/xiaochan/enroll", { offerId }, "POST", c)).status, 200);
      const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      snapshot.xiaochanAccount = { silkId: "123456789", userId: "6789", accessToken: token };
      snapshot.xiaochanEnrollments = {
        "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: new Date().toISOString() },
        "xiaochan:43": { state: "enrolled", orderId: "9043", updatedAt: new Date().toISOString() },
      };
      const syncCookie = await seedSession(snapshot);
      const response = await call("/api/sync", { provider: "xiaochan" }, "POST", syncCookie);
      assert.equal(response.status, 200);
      const result = await response.json();
      const offers = result.data.offers.xiaochan;
      assert.equal(offers.find((offer: any) => offer.id === "xiaochan:42").enrollment?.state,
        token === "enroll-sync-cancel" ? undefined : "enrolled");
      assert.equal(offers.find((offer: any) => offer.id === "xiaochan:43").enrollment.state, "enrolled");
      assert.equal(result.errors.length, token === "enroll-sync-cancel" ? 0 : 1);
      assert.equal(result.data.connections.xiaochan.state, token === "enroll-sync-expired" ? "expired" : "connected");
      const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: syncCookie } })).json();
      assert.deepEqual(saved.offers.xiaochan, offers);
    });
  }
  for (const token of ["enroll-cancel-success", "enroll-cancel-lost", "enroll-cancel-failure", "enroll-cancel-rejected", "enroll-cancel-expired"]) {
    await test(`${token} cancels the selected enrollment without changing another tier`, async () => {
      const c = await enrollmentSession(token);
      for (const offerId of ["xiaochan:42", "xiaochan:43"])
        assert.equal((await call("/api/xiaochan/enroll", { offerId }, "POST", c)).status, 200);
      const response = await call("/api/xiaochan/cancel", { offerId: "xiaochan:42", orderId: "9043" }, "POST", c);
      const cancelled = ["enroll-cancel-success", "enroll-cancel-lost"].includes(token);
      assert.equal(response.status, cancelled ? 200 : token.endsWith("expired") ? 401 : token.endsWith("rejected") ? 400 : 409);
      const result = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      assert.equal(result.offers.xiaochan[0].enrollment?.state, cancelled ? undefined : token.endsWith("failure") ? "cancel-unknown" : "enrolled");
      assert.equal(result.offers.xiaochan[1].enrollment.state, "enrolled");
      if (cancelled) assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, 200);
    });
  }
  await test("Cancellation and scheduling validate sessions and reject cross-origin requests", async () => {
    const c = await freshCookie();
    for (const path of ["/api/xiaochan/cancel", "/api/xiaochan/schedule"]) {
      assert.equal((await call(path, { offerId: "xiaochan:42", runAt: new Date(Date.now() + 60_000).toISOString() }, "POST", c)).status, 401);
      assert.equal((await call(path, { offerId: "xiaochan:42" }, "POST", c, { origin: "https://evil.example" })).status, 403);
    }
  });
  await test("Scheduled enrollment executes without an open webpage and cancelled tasks never claim quota", async () => {
    const c = await enrollmentSession("enroll-scheduled-success");
    const runAt = new Date(Date.now() + 2000).toISOString();
    const response = await call("/api/xiaochan/schedule", { offerId: "xiaochan:42", runAt }, "POST", c);
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.enrollmentSchedules[0].state, "scheduled");
    assert.equal(created.enrollmentSchedules[0].runAt, runAt);
    assert.equal(created.offers.xiaochan[0].enrollment, undefined);
    assert.equal(created.enrollmentSchedules[0].offer, undefined);
    assert.equal(created.enrollmentSchedules[0].accountId, undefined);
    assert.equal((await call("/api/xiaochan/schedule", { offerId: "xiaochan:43", runAt }, "POST", c)).status, 200);
    assert.equal((await call("/api/xiaochan/schedule", { offerId: "xiaochan:43" }, "DELETE", c)).status, 200);
    let result: any;
    for (let i = 0; i < 80; i++) {
      result = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      if (result.offers.xiaochan[0].enrollment?.state === "enrolled") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(result.offers.xiaochan[0].enrollment.state, "enrolled");
    assert.equal(result.offers.xiaochan[1].enrollment, undefined);
    assert.deepEqual(result.enrollmentSchedules, []);
    assert.equal((await call("/api/xiaochan/schedule", { offerId: "xiaochan:42", runAt: new Date(Date.now() + 60_000).toISOString() }, "POST", c)).status, 409);
  });
  await test("Schedule API rejects earlier times, other dates and activity-end boundaries", async () => {
    const c = await enrollmentSession("enroll-schedule-boundaries");
    const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    snapshot.xiaochanAccount = { silkId: "123456789", userId: "6789", accessToken: "enroll-schedule-boundaries" };
    const end = new Date(Date.now() + 2 * 60_000);
    snapshot.offers.xiaochan[0].validUntil = end.toISOString();
    const checkedCookie = await seedSession(snapshot);
    const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(`${day}T00:00:00+08:00`) + 24 * 3600_000);
    for (const time of [new Date(Date.now() - 1000), end, new Date(end.getTime() + 1000), tomorrow])
      assert.equal((await call("/api/xiaochan/schedule", { offerId: "xiaochan:42", runAt: time.toISOString() }, "POST", checkedCookie)).status, 400);
    const result = await (await fetch(base + "/api/dashboard", { headers: { cookie: checkedCookie } })).json();
    assert.deepEqual(result.enrollmentSchedules, []);
  });
  await test("Service restart restores pending schedules and never replays interrupted quota requests", async () => {
    const c = await enrollmentSession("enroll-scheduled-restart");
    const snapshot = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    const runAt = new Date(Date.now() + 2500).toISOString();
    snapshot.xiaochanAccount = { silkId: "123456789", userId: "6789", accessToken: "enroll-scheduled-restart" };
    snapshot.xiaochanEnrollments = { "xiaochan:43": { state: "unknown", updatedAt: new Date().toISOString() } };
    snapshot.xiaochanSchedules = Object.fromEntries([42, 43].map(id => [`xiaochan:${id}`, {
      offerId: `xiaochan:${id}`, name: "测试店", runAt, state: id === 42 ? "scheduled" : "running",
      offer: snapshot.offers.xiaochan.find((row: any) => row.id === `xiaochan:${id}`),
      location: snapshot.location, accountId: "123456789:6789",
    }]));
    const restartDirectory = await mkdtemp(join(tmpdir(), "food-schedule-restart-"));
    const key = await readFile(join(directory, "session.key"));
    const id = randomBytes(32).toString("hex"), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
    await writeFile(join(restartDirectory, "session.key"), key);
    await writeFile(join(restartDirectory, `${id}.enc`), Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
    const restartPort = port + 1;
    const child = spawn(process.execPath, ["--import", join(process.cwd(), "tests/fixtures/waimai-upstream.mjs"), ".output/server/index.mjs"], {
      env: { ...process.env, HOST: "127.0.0.1", FOOD_ALLOW_LAN: "0", PORT: String(restartPort), FOOD_DATA_DIR: restartDirectory }, stdio: "ignore",
    });
    try {
      let result: any;
      for (let i = 0; i < 120; i++) {
        try {
          const response = await fetch(`http://127.0.0.1:${restartPort}/api/dashboard`, { headers: { cookie: `food-session=${id}` } });
          if (response.ok) result = await response.json();
          if (result?.offers.xiaochan[0].enrollment?.state === "enrolled") break;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(result?.offers.xiaochan[0].enrollment.state, "enrolled");
      assert.equal(result.offers.xiaochan[1].enrollment.state, "unknown");
      assert.equal(result.enrollmentSchedules.length, 1);
      assert.equal(result.enrollmentSchedules[0].state, "failed");
      assert.equal(result.enrollmentSchedules[0].message, "报名待确认");
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await rm(restartDirectory, { recursive: true, force: true });
    }
  });
  await test("Enrollment buttons isolate pending activity IDs and preserve reversed concurrent responses", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const collectedAt = new Date().toISOString();
      const offer = { name: "报名测试店", category: "美食", inventory: 3, distanceMeters: 1000,
        startTime: "00:00", endTime: "24:00", requirement: "无需评价", source: "live",
        rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 }, collectedAt };
      const dashboard: any = {
        location: { label: "南宁", cityCode: 450103, latitude: 22.82, longitude: 108.36 },
        connections: {
          xiaochan: { state: "connected", label: "已登录", profile: { userId: "6789" } },
          waimai: { state: "disconnected", label: "未连接" }, meituan: { state: "disconnected", label: "未连接" },
        },
        offers: {
          xiaochan: [42, 43, 44].map(id => ({ ...offer, provider: "xiaochan", id: `xiaochan:${id}` })),
          waimai: [], meituan: [1, 2].map(id => ({ ...offer, provider: "meituan", id: `meituan:${id}` })),
        }, updatedAt: {},
      };
      const pending = new Map<string, (fail?: boolean) => Promise<void>>();
      const requests: string[] = [];
      let rejectNextSchedule = false;
      await page.route("**/api/**", async route => {
        if (route.request().url().endsWith("/api/xiaochan/cancel")) {
          const { offerId } = route.request().postDataJSON();
          delete dashboard.offers.xiaochan.find((row: any) => row.id === offerId).enrollment;
          await route.fulfill({ json: dashboard });
          return;
        }
        if (route.request().url().endsWith("/api/xiaochan/schedule")) {
          const { offerId, runAt } = route.request().postDataJSON();
          if (route.request().method() === "POST" && (Date.parse(runAt) <= Date.now() || rejectNextSchedule)) {
            rejectNextSchedule = false;
            await route.fulfill({ status: 400, json: { statusMessage: "请选择有效的报名时间" } });
            return;
          }
          const row = dashboard.offers.xiaochan.find((row: any) => row.id === offerId);
          if (route.request().method() === "DELETE") {
            delete row.enrollmentSchedule;
            dashboard.enrollmentSchedules = [];
          } else {
            row.enrollmentSchedule = { offerId, name: row.name, state: "scheduled", runAt: new Date(runAt).toISOString() };
            dashboard.enrollmentSchedules = [row.enrollmentSchedule];
          }
          await route.fulfill({ json: dashboard });
          return;
        }
        if (route.request().url().endsWith("/api/xiaochan/enroll")) {
          const { offerId } = route.request().postDataJSON();
          requests.push(offerId);
          const response = structuredClone(dashboard);
          response.offers.xiaochan.find((row: any) => row.id === offerId).enrollment = { state: "enrolled", orderId: offerId.slice(9) };
          pending.set(offerId, async (fail = false) => {
            pending.delete(offerId);
            if (fail) {
              dashboard.offers.xiaochan.find((row: any) => row.id === offerId).enrollment = { state: "unknown" };
              await route.fulfill({ status: 502, json: { statusMessage: "报名待确认" } });
            } else await route.fulfill({ json: response });
          });
          return;
        }
        await route.fulfill({ json: route.request().url().endsWith("/api/sync")
          ? { data: dashboard, errors: [], message: "同步完成" } : dashboard });
      });
      await page.goto(base);
      await page.waitForFunction(() => document.querySelectorAll(".enrollment-button").length === 6 &&
        !document.querySelector(".sync-button")?.textContent?.includes("正在同步"));
      const buttons = page.locator(".enrollment-button");
      const controls = page.locator(".enrollment-actions").first();
      const firstBounds = await controls.locator("button").nth(0).boundingBox();
      const secondBounds = await controls.locator("button").nth(1).boundingBox();
      assert.ok(firstBounds && secondBounds);
      assert.ok(Math.abs(firstBounds.y - secondBounds.y) < 1);
      assert.ok(secondBounds.x - firstBounds.x - firstBounds.width >= 7.9);
      assert.equal(firstBounds.height, secondBounds.height);
      await controls.locator("button").nth(1).hover();
      assert.equal(await controls.locator("button").nth(1).evaluate(element => getComputedStyle(element).textDecorationLine), "none");
      assert.equal(await page.getByRole("button", { name: "导出结果" }).count(), 0);
      if (process.env.FOOD_UI_SCREENSHOTS) await page.screenshot({ path: "/tmp/food-schedule-desktop.png", fullPage: true });
      await buttons.nth(0).click();
      await page.waitForFunction(() => document.querySelectorAll('.enrollment-button[aria-busy="true"]').length === 2);
      assert.equal(await buttons.nth(0).textContent(), "报名中…");
      assert.equal(await buttons.nth(1).isDisabled(), true, "The same activity in another match must block duplicate submission");
      assert.equal(await buttons.nth(2).isEnabled(), true, "Another activity tier must remain available");
      assert.equal(await buttons.nth(4).isEnabled(), true);
      await buttons.nth(2).click();
      await page.waitForFunction(() => document.querySelectorAll('.enrollment-button[aria-busy="true"]').length === 4);
      await pending.get("xiaochan:43")!();
      await page.waitForFunction(() => document.querySelectorAll(".enrollment-button")[2]?.textContent === "已报名");
      await pending.get("xiaochan:42")!();
      await page.waitForFunction(() => document.querySelectorAll(".enrollment-button")[0]?.textContent === "已报名");
      assert.equal(await buttons.nth(2).textContent(), "已报名", "An older full dashboard must not revert another enrollment");
      assert.equal(await buttons.nth(4).isEnabled(), true);
      await buttons.nth(4).click();
      await page.waitForFunction(() => document.querySelectorAll('.enrollment-button[aria-busy="true"]').length === 2);
      await pending.get("xiaochan:44")!(true);
      await page.waitForFunction(() => document.querySelectorAll(".enrollment-button")[4]?.textContent === "查看报名");
      assert.equal(await buttons.nth(4).isEnabled(), true);
      assert.equal(await buttons.nth(0).textContent(), "已报名");
      assert.equal(await buttons.nth(2).textContent(), "已报名");
      assert.deepEqual(requests, ["xiaochan:42", "xiaochan:43", "xiaochan:44"]);
      assert.equal(await page.locator('.enrollment-button[aria-busy="true"]').count(), 0);
      dashboard.offers.xiaochan[1].enrollment = { state: "enrolled", orderId: "9043" };
      const cutoff = new Date(Date.now() + 10 * 60_000);
      const localCutoff = new Date(cutoff.getTime() + 8 * 3600_000).toISOString().slice(0, 19);
      const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      dashboard.offers.xiaochan[0].endTime = localCutoff.slice(0, 10) === today ? localCutoff.slice(11, 16) : "24:00";
      dashboard.offers.xiaochan[0].validUntil = cutoff.toISOString();
      await page.locator(".sync-button").click();
      await page.waitForFunction(() => document.querySelectorAll(".enrollment-button")[0]?.textContent === "报名");
      assert.equal(await buttons.nth(0).isEnabled(), true, "Phone cancellation must restore the enrollment button after sync");
      assert.equal(await buttons.nth(2).textContent(), "已报名", "Sync must retain the other activity tier");
      page.once("dialog", dialog => dialog.accept());
      await page.locator(".cancel-enrollment-button").first().click();
      await page.waitForFunction(() => document.querySelectorAll(".enrollment-button")[2]?.textContent === "报名");
      assert.equal(await buttons.nth(2).isEnabled(), true);
      await page.locator(".schedule-enrollment-button").first().click();
      assert.equal(await page.getByRole("dialog", { name: "预约报名", exact: true }).isVisible(), true);
      assert.equal(await page.locator('input[type="time"], input[type="datetime-local"]').count(), 0);
      await page.getByRole("combobox", { name: "报名小时" }).click();
      const hours = page.getByRole("listbox", { name: "报名小时" });
      const currentHour = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 13));
      assert.ok((await hours.getByRole("option").allTextContents()).every(value => Number(value.trim()) >= currentHour));
      await hours.getByRole("option").last().click();
      await page.getByRole("combobox", { name: "报名分钟" }).click();
      const minuteList = page.getByRole("listbox", { name: "报名分钟" });
      const lastMinute = await minuteList.getByRole("option").last().innerText();
      const expectedMinute = dashboard.offers.xiaochan[0].endTime === "24:00" ? "59" : String((Number(localCutoff.slice(14, 16)) + 59) % 60).padStart(2, "0");
      assert.equal(lastMinute.trim(), expectedMinute);
      await minuteList.getByRole("option").last().click();
      await page.getByRole("combobox", { name: "报名秒钟" }).click();
      await page.getByRole("listbox", { name: "报名秒钟" }).press("End");
      await page.getByRole("listbox", { name: "报名秒钟" }).press("Enter");
      if (process.env.FOOD_UI_SCREENSHOTS) await page.screenshot({ path: "/tmp/food-schedule-dialog.png" });
      rejectNextSchedule = true;
      await page.getByRole("button", { name: "确认预约", exact: true }).click();
      await page.getByRole("dialog", { name: "预约报名", exact: true }).getByRole("alert").waitFor();
      assert.equal(await page.getByRole("dialog", { name: "预约报名", exact: true }).getByRole("alert").innerText(), "请选择有效的报名时间");
      await page.getByRole("button", { name: "确认预约", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".scheduled-enrollments") !== null);
      assert.equal(await buttons.nth(0).isDisabled(), true);
      await page.locator(".scheduled-enrollments").getByRole("button", { name: "取消预约", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".scheduled-enrollments") === null);
      assert.equal(await buttons.nth(0).isEnabled(), true);
      await page.locator(".schedule-enrollment-button").first().click();
      await page.getByRole("button", { name: "确认预约", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".scheduled-enrollments") !== null);
      dashboard.enrollmentSchedules = [];
      delete dashboard.offers.xiaochan[0].enrollmentSchedule;
      dashboard.offers.xiaochan[0].enrollment = { state: "enrolled", orderId: "9042" };
      await page.waitForFunction(() => document.querySelectorAll(".enrollment-button")[0]?.textContent === "已报名");
      assert.equal(await page.locator(".notice").innerText(), "预约报名成功");
      assert.equal(await page.locator(".notice").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(255, 255, 255)");
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      const mobileFirst = await controls.locator("button").nth(0).boundingBox(), mobileSecond = await controls.locator("button").nth(1).boundingBox();
      assert.ok(mobileFirst && mobileSecond && Math.abs(mobileFirst.y - mobileSecond.y) < 1);
      assert.ok(mobileSecond.x - mobileFirst.x - mobileFirst.width >= 7.9);
      if (process.env.FOOD_UI_SCREENSHOTS) await page.screenshot({ path: "/tmp/food-schedule-mobile.png", fullPage: true });
      await page.locator(".schedule-enrollment-button").first().click();
      await page.getByRole("combobox", { name: "报名分钟" }).click();
      const pickerBounds = await page.locator(".time-picker").boundingBox();
      assert.ok(pickerBounds);
      const clockParts = await page.locator(".time-picker .ui-select-trigger").all();
      let previousRight = pickerBounds.x;
      for (const part of clockParts) {
        const box = await part.boundingBox();
        assert.ok(box && box.x >= previousRight && box.x + box.width <= pickerBounds.x + pickerBounds.width + 1);
        previousRight = box.x + box.width;
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      if (process.env.FOOD_UI_SCREENSHOTS) await page.screenshot({ path: "/tmp/food-schedule-mobile-dialog.png" });
    } finally {
      await browser.close();
    }
  });
  for (const password of ["enroll-network-failure", "enroll-http-failure", "enroll-missing-order"]) {
    await test(`${password} persists unknown enrollment and blocks subsequent quota attempts`, async () => {
      const c = await enrollmentSession(password);
      const response = await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c);
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.ok(!text.includes("private-upstream-field"));
      assert.ok(!text.includes("private-enrollment-network-error"));
      const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      assert.equal(saved.offers.xiaochan.find((offer: any) => offer.id === "xiaochan:42").enrollment.state, "unknown");
      assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, 409);
    });
  }
  await test("Read-only enrollment lookup confirms the same user activity without a second quota claim", async () => {
    const c = await enrollmentSession("enroll-lookup-success");
    assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, 502);
    const response = await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.offers.xiaochan.find((offer: any) => offer.id === "xiaochan:42").enrollment, { state: "enrolled", orderId: "9042" });
    assert.equal(data.offers.xiaochan.find((offer: any) => offer.id === "xiaochan:43").enrollment, undefined);
  });
  for (const password of ["enroll-lookup-mismatched", "enroll-lookup-affiliate", "enroll-lookup-expired"]) {
    await test(`${password} cannot confirm another activity or an unauthenticated lookup`, async () => {
      const c = await enrollmentSession(password);
      assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, 502);
      assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, password.endsWith("expired") ? 401 : 409);
      const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      assert.equal(saved.offers.xiaochan.find((offer: any) => offer.id === "xiaochan:42").enrollment.state, "unknown");
      assert.equal(saved.connections.xiaochan.state, password.endsWith("expired") ? "expired" : "connected");
    });
  }
  await test("Explicit enrollment rejection does not mark success or retain an uncertain attempt", async () => {
    const c = await enrollmentSession("enroll-rejected");
    assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, 400);
    const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    assert.equal(saved.offers.xiaochan.find((offer: any) => offer.id === "xiaochan:42").enrollment, undefined);
    assert.equal(saved.connections.xiaochan.state, "connected");
  });
  await test("Confirmed login expiry while enrolling updates the account without losing its activity list", async () => {
    const c = await enrollmentSession("enroll-expired");
    assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, 401);
    const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
    assert.equal(saved.connections.xiaochan.state, "expired");
    assert.equal(saved.offers.xiaochan.length, 4);
    assert.equal(saved.offers.xiaochan.find((offer: any) => offer.id === "xiaochan:42").enrollment, undefined);
  });
  await test("Imported activities cannot be submitted as native enrollment targets", async () => {
    const c = await nativeXiaochan(await freshCookie());
    await call("/api/import", { provider: "xiaochan", offers: [{ ...row, id: "42" }] }, "POST", c);
    assert.equal((await call("/api/xiaochan/enroll", { offerId: "xiaochan:42" }, "POST", c)).status, 404);
  });
  const accountWithoutProfile = async (provider: "xiaochan" | "waimai", token?: string) => {
    const snapshot = await (await fetch(base + "/api/dashboard")).json();
    snapshot.connections[provider] = { state: "connected", label: "微信已连接" };
    if (provider === "xiaochan") snapshot.xiaochanAccount = {
      silkId: "123456789", userId: "6789", accessToken: token || "wechat-test-success",
      platform: "mini", expiresAt: Date.now() + 3600_000,
    };
    else snapshot.waimaiAccount = { userId: waimaiUserId, uid: waimaiUid, token: token || "wechat-waimai-test-success" };
    snapshot.location = { label: "南宁", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 };
    return seedSession(snapshot);
  };
  for (const provider of ["xiaochan", "waimai"] as const) {
    await test(`${provider} fills missing basic profile from the saved account without replacing activities`, async () => {
      const c = await accountWithoutProfile(provider);
      await call("/api/import", { provider, offers: [row] }, "POST", c);
      const response = await call(`/api/connections/${provider}/profile`, undefined, "POST", c);
      assert.equal(response.status, 200);
      const text = await response.text(), result = JSON.parse(text);
      assert.equal(result.connections[provider].label, "已登录");
      assert.equal(result.connections[provider].profile.userId, provider === "xiaochan" ? "6789" : waimaiUid);
      assert.ok(result.connections[provider].profile.nickname);
      assert.ok(result.connections[provider].profile.avatar);
      assert.equal(result.connections[provider].profile.phone, "138****0000");
      assert.equal(result.offers[provider][0].source, "import");
      assert.ok(!text.includes("wechat-test-success") && !text.includes("wechat-waimai-test-success"));
      const persisted = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      assert.deepEqual(persisted.connections[provider].profile, result.connections[provider].profile);
    });
  }
  for (const [token, status] of [["wechat-test-expired", 401], ["wechat-test-network-failure", 502]] as const) {
    await test(`profile backfill handles ${token} without losing saved activities`, async () => {
      const c = await accountWithoutProfile("xiaochan", token);
      await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
      assert.equal((await call("/api/connections/xiaochan/profile", undefined, "POST", c)).status, status);
      const saved = await (await fetch(base + "/api/dashboard", { headers: { cookie: c } })).json();
      assert.equal(saved.connections.xiaochan.state, status === 401 ? "expired" : "connected");
      assert.equal(saved.offers.xiaochan[0].source, "import");
    });
  }
  await test("profile requests require an existing account and reject supplied credentials", async () => {
    const c = await freshCookie();
    assert.equal((await call("/api/connections/xiaochan/profile", undefined, "POST", c)).status, 401);
    assert.equal((await call("/api/connections/waimai/profile", { token: "private" }, "POST", c)).status, 400);
    assert.equal((await call("/api/connections/meituan/profile", undefined, "POST", c)).status, 404);
  });
  for (const operation of ["profile", "reconnect", "disconnect", "location"] as const) {
    await test(`slow activity sync allows ${operation} and cannot restore stale account or location results`, async () => {
      const c = await accountWithoutProfile("xiaochan", "wechat-test-slow-sync");
      await call("/api/import", { provider: "xiaochan", offers: [row] }, "POST", c);
      let completed = false;
      const pendingSync = call("/api/sync", { provider: "xiaochan" }, "POST", c).then(response => {
        completed = true;
        return response.json();
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      let response: Response;
      if (operation === "profile") response = await call("/api/connections/xiaochan/profile", undefined, "POST", c);
      else if (operation === "disconnect") response = await call("/api/connections/xiaochan", undefined, "DELETE", c);
      else if (operation === "location") response = await call("/api/location", {
        label: "新地址", cityName: "南宁市", cityCode: 450103, latitude: 22.83, longitude: 108.37,
      }, "POST", c);
      else {
        await setWeChatStorage();
        response = await call("/api/connections/xiaochan/wechat", undefined, "POST", c);
      }
      assert.equal(response.status, 200);
      assert.equal(completed, false, "Account operations must complete while upstream sync is pending");
      if (operation === "profile") assert.ok((await response.json()).connections.xiaochan.profile);
      const result = await pendingSync;
      if (operation === "profile") {
        assert.ok(result.data.connections.xiaochan.profile);
        assert.equal(result.data.offers.xiaochan[0].source, "live");
      } else if (operation === "reconnect") {
        assert.ok(result.data.connections.xiaochan.profile);
        assert.equal(result.data.offers.xiaochan[0].source, "import");
      } else {
        assert.deepEqual(result.data.offers.xiaochan, []);
        if (operation === "disconnect") assert.equal(result.data.connections.xiaochan.state, "disconnected");
        else assert.equal(result.data.location.latitude, 22.83);
      }
    });
  }
  await test("Legacy imported credentials are removed and cannot restore guest access", async () => {
    const snapshot = await (await fetch(base + "/api/dashboard")).json();
    snapshot.location = { label: "南宁", cityName: "南宁市", cityCode: 450103, latitude: 22.82, longitude: 108.36 };
    snapshot.xiaochanHeaders = { "x-teemo": "0", "x-vayne": "0", "x-session-id": "legacy-guest-canary" };
    snapshot.waimaiToken = "";
    snapshot.connections.xiaochan = { state: "configured", label: "访客访问" };
    snapshot.connections.waimai = { state: "configured", label: "访客访问" };
    snapshot.offers.xiaochan = [{ ...row, id: "xiaochan:001", provider: "xiaochan", source: "import" }];
    const c = await seedSession(snapshot);
    const response = await fetch(base + "/api/dashboard", { headers: { cookie: c } });
    const text = await response.text(), data = JSON.parse(text);
    assert.equal(data.connections.xiaochan.state, "disconnected");
    assert.equal(data.connections.waimai.state, "disconnected");
    assert.equal(data.offers.xiaochan[0].id, "xiaochan:001");
    assert.ok(!text.includes("legacy-guest-canary"));
    for (const provider of ["xiaochan", "waimai"])
      assert.equal((await call("/api/sync", { provider }, "POST", c)).status, 400);
    const id = c.split("=")[1]!;
    const encrypted = await readFile(join(directory, id + ".enc"));
    const key = await readFile(join(directory, "session.key"));
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    const saved = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString());
    assert.equal(saved.xiaochanHeaders, undefined);
    assert.equal(saved.waimaiToken, undefined);
  });

} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
  await rm(wechatDirectory, { recursive: true, force: true });
}
