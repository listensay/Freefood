import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createError } from "h3";
import { fetchXiaochanAdvanceCoupons } from "../server/utils/xiaochan-advance-coupons";
import {
  xiaochanRpc,
  type XiaochanAccount,
} from "../server/utils/xiaochan-rpc";

const now = new Date("2026-11-07T01:00:00Z");
const expiry = now.getTime() / 1000 + 3600;
const account: XiaochanAccount = {
  silkId: "123456789",
  userId: "6789",
  accessToken: "coupon-test-token",
  platform: "mini",
};
const location = {
  label: "测试地址",
  cityCode: 310100,
  latitude: 31.23,
  longitude: 121.47,
};
const row = (id: number | string, extra: Record<string, unknown> = {}) => ({
  id,
  card: { card_type: 1 },
  expire_time: expiry,
  ...extra,
});
const response = (list: unknown) => ({ status: { code: 0 }, list });
const rpcWith = (run: (...args: Parameters<typeof xiaochanRpc>) => unknown) =>
  run as typeof xiaochanRpc;

test("Advance coupons use the exact authenticated card-list RPC without consuming a card", async () => {
  const original = structuredClone({ account, location });
  let requests = 0;
  const coupons = await fetchXiaochanAdvanceCoupons(account, location, {
    now,
    rpc: rpcWith(async (request) => {
      requests++;
      assert.equal(request.serverName, "SilkwormCard");
      assert.equal(request.methodName, "SilkwormCardService.GetUserCardList");
      assert.deepEqual(request.body, {
        silk_id: 123456789,
        status: 0,
        offset: 0,
        number: 20,
        card_types: [1],
      });
      assert.equal(request.headers["x-teemo"], account.silkId);
      assert.equal(request.headers["x-vayne"], account.userId);
      assert.equal(request.headers["x-sivir"], account.accessToken);
      assert.equal(request.headers["x-platform"], "mini");
      assert.deepEqual(request.location, location);
      return response([row(42)]);
    }),
  });
  assert.deepEqual(coupons, [
    { id: "42", startsAt: now.getTime(), expiresAt: expiry * 1000 },
  ]);
  assert.equal(requests, 1);
  assert.deepEqual({ account, location }, original);
});

test("Advance coupons accept empty and status-only responses and pass through a null location", async () => {
  for (const result of [
    response([]),
    { status: { code: 0 } },
    { status: { code: "0", msg: "ok" } },
  ]) {
    assert.deepEqual(
      await fetchXiaochanAdvanceCoupons(account, null, {
        now,
        rpc: rpcWith(async (request) => {
          assert.equal(request.location, null);
          return result;
        }),
      }),
      [],
    );
  }
});

test("Advance coupons retain only unused type 1 cards and exclude the exact expiry boundary", async () => {
  const list = [
    row(1),
    row("2", {
      card: { card_type: "1" },
      status: "0",
      expire_time: String(expiry),
    }),
    row(3, { status: 1 }),
    row(4, { status: "2" }),
    row(5, { card: { card_type: 12 } }),
    row(6, { card: { card_type: 0 } }),
    row(7, { expire_time: now.getTime() / 1000 }),
    row(8, { expire_time: now.getTime() / 1000 - 1 }),
    row(9, { expire_time: 0 }),
    row(10, { expire_time: now.getTime() / 1000 + 1 }),
  ];
  const result = await fetchXiaochanAdvanceCoupons(account, null, {
    now,
    rpc: rpcWith(async () => response(list)),
  });
  assert.deepEqual(
    result.map((coupon) => coupon.id),
    ["1", "2", "10"],
  );
  assert.equal(result[2]!.expiresAt, now.getTime() + 1000);
});

test("Coupon activation is the fixed query baseline rather than an unverified upstream field", async () => {
  const result = await fetchXiaochanAdvanceCoupons(account, null, {
    now,
    rpc: rpcWith(async () =>
      response([
        row(1, {
          start_time: expiry + 1,
          starts_at: expiry + 2,
          effective_time: expiry + 3,
        }),
      ]),
    ),
  });
  assert.equal(result[0]!.startsAt, now.getTime());
});

test("Duplicate numeric and string coupon IDs count once", async () => {
  const result = await fetchXiaochanAdvanceCoupons(account, null, {
    now,
    rpc: rpcWith(async () =>
      response([row(42), row("42"), row(Number.MAX_SAFE_INTEGER)]),
    ),
  });
  assert.deepEqual(
    result.map((coupon) => coupon.id),
    ["42", String(Number.MAX_SAFE_INTEGER)],
  );
});

test("Coupon pages increment offset by 20 and wait six seconds before the next request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = fetchXiaochanAdvanceCoupons(account, null, {
    now,
    rpc: rpcWith(async (request) => {
      assert.equal(request.body.offset, calls * 20);
      calls++;
      return response(
        calls === 1
          ? Array.from({ length: 20 }, (_, i) => row(i + 1))
          : [row("20"), row(21)],
      );
    }),
  });
  assert.equal(calls, 1);
  await setImmediate();
  t.mock.timers.tick(5999);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(calls, 2);
  assert.equal(result.length, 21);
  assert.ok(result.every((coupon) => coupon.startsAt === now.getTime()));
});

test("A full page requires a final empty page even when every coupon is expired", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = fetchXiaochanAdvanceCoupons(account, null, {
    now,
    rpc: rpcWith(async () => {
      calls++;
      return calls === 1
        ? response(
            Array.from({ length: 20 }, (_, i) =>
              row(i + 1, { expire_time: 0 }),
            ),
          )
        : { status: { code: 0 } };
    }),
  });
  await setImmediate();
  t.mock.timers.tick(6000);
  assert.deepEqual(await pending, []);
  assert.equal(calls, 2);
});

test("Repeated pages, including reordered or short duplicate pages, never return a partial result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = Array.from({ length: 20 }, (_, i) => row(i + 1));
  for (const repeated of [first, [...first].reverse(), [first[0]]]) {
    let calls = 0;
    const pending = fetchXiaochanAdvanceCoupons(account, null, {
      now,
      rpc: rpcWith(async () => response(++calls === 1 ? first : repeated)),
    });
    const rejected = assert.rejects(pending, {
      statusCode: 502,
      statusMessage: "超前抢单券分页未更新，请重试",
    });
    await setImmediate();
    t.mock.timers.tick(6000);
    await rejected;
    assert.equal(calls, 2);
  }
});

test("One hundred full coupon pages fail closed without requesting page 101", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = fetchXiaochanAdvanceCoupons(account, null, {
    now,
    rpc: rpcWith(async (request) => {
      assert.equal(request.body.offset, calls * 20);
      const offset = calls++ * 20;
      return response(
        Array.from({ length: 20 }, (_, i) => row(offset + i + 1)),
      );
    }),
  });
  const rejected = assert.rejects(pending, {
    statusCode: 502,
    statusMessage: "超前抢单券未加载完整，请重试",
  });
  for (let page = 1; page < 100; page++) {
    await setImmediate();
    t.mock.timers.tick(6000);
  }
  await rejected;
  assert.equal(calls, 100);
});

test("Malformed response containers cannot be interpreted as an empty card balance", async () => {
  const invalid = [
    null,
    [],
    {},
    { status: null },
    { status: { code: false }, list: [] },
    { status: { code: "00" }, list: [] },
    { status: { code: 401 }, list: [] },
    { status: { code: 0 }, total: 0 },
    response(null),
    response({}),
    response("[]"),
    response(Array.from({ length: 21 }, (_, i) => row(i + 1))),
  ];
  for (const result of invalid)
    await assert.rejects(
      fetchXiaochanAdvanceCoupons(account, null, {
        now,
        rpc: rpcWith(async () => result),
      }),
      { statusCode: 502 },
    );
});

test("Malformed card records and unsafe IDs reject the entire otherwise-valid page", async () => {
  const invalid = [
    null,
    [],
    "card",
    {},
    { ...row(1), card: null },
    row(1, { card: {} }),
    ...[
      undefined,
      null,
      false,
      0,
      -1,
      1.5,
      "",
      "01",
      " 1",
      "1e2",
      "9007199254740992",
      Number.MAX_SAFE_INTEGER + 1,
    ].map((id) => ({ ...row(1), id })),
    ...[undefined, null, false, -1, 1.5, "bad", Number.MAX_SAFE_INTEGER].map(
      (expire_time) => row(1, { expire_time }),
    ),
    ...[null, false, -1, "bad", 0.5].map((status) => row(1, { status })),
    ...[null, false, -1, "bad", 1.5].map((card_type) =>
      row(1, { card: { card_type } }),
    ),
  ];
  for (const item of invalid)
    await assert.rejects(
      fetchXiaochanAdvanceCoupons(account, null, {
        now,
        rpc: rpcWith(async () => response([row(99), item])),
      }),
      { statusCode: 502 },
    );
});

test("Conflicting duplicate coupon records are not counted using stale expiry or status", async () => {
  for (const extra of [
    { status: 1 },
    { expire_time: expiry + 1 },
    { card: { card_type: 12 } },
  ])
    await assert.rejects(
      fetchXiaochanAdvanceCoupons(account, null, {
        now,
        rpc: rpcWith(async () => response([row(1), row("1", extra)])),
      }),
      { statusCode: 502 },
    );
});

test("A malformed later page rejects without returning the first page's valid coupons", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = fetchXiaochanAdvanceCoupons(account, null, {
    now,
    rpc: rpcWith(async () =>
      response(
        ++calls === 1
          ? Array.from({ length: 20 }, (_, i) => row(i + 1))
          : [null],
      ),
    ),
  });
  const rejected = assert.rejects(pending, { statusCode: 502 });
  await setImmediate();
  t.mock.timers.tick(6000);
  await rejected;
  assert.equal(calls, 2);
});

test("Invalid or expired accounts are rejected before coupon requests", async () => {
  for (const invalid of [
    undefined,
    { ...account, silkId: "0" },
    { ...account, userId: "bad" },
    { ...account, accessToken: "" },
    { ...account, expiresAt: 1 },
    { ...account, expiresAt: now.getTime() },
  ]) {
    await assert.rejects(
      fetchXiaochanAdvanceCoupons(invalid as XiaochanAccount, null, {
        now,
        rpc: rpcWith(async () => assert.fail("Unexpected coupon request")),
      }),
      { statusCode: 401 },
    );
  }
  await assert.rejects(
    fetchXiaochanAdvanceCoupons(account, null, {
      now: new Date("invalid"),
      rpc: rpcWith(async () => assert.fail("Unexpected coupon request")),
    }),
    { statusCode: 502 },
  );
});

test("Expired login and rate-limit RPC errors propagate without retries or partial success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const statusCode of [401, 429, 502]) {
    let calls = 0;
    const failure = createError({ statusCode, statusMessage: "查询失败" });
    const pending = fetchXiaochanAdvanceCoupons(account, null, {
      now,
      rpc: rpcWith(async () => {
        if (++calls === 1)
          return response(Array.from({ length: 20 }, (_, i) => row(i + 1)));
        throw failure;
      }),
    });
    const rejected = assert.rejects(pending, (error) => error === failure);
    await setImmediate();
    t.mock.timers.tick(6000);
    await rejected;
    assert.equal(calls, 2);
  }
});

test("Real RPC authentication classification is retained when coupon lookup receives an expired-login response", async () => {
  let calls = 0;
  await assert.rejects(
    fetchXiaochanAdvanceCoupons(account, null, {
      now,
      rpc: rpcWith((request) =>
        xiaochanRpc(request, (async () => {
          calls++;
          return Response.json({
            status: { code: 401, msg: "private upstream detail" },
          });
        }) as typeof fetch),
      ),
    }),
    (error: any) =>
      error.statusCode === 401 &&
      error.data.xiaochanOutcome === "rejected" &&
      !error.message.includes("private"),
  );
  assert.equal(calls, 1);
});
