import test from "node:test";
import assert from "node:assert/strict";
import { createError } from "h3";
import { applyXiaochanEnrollmentUpdates, cancelXiaochanEnrollment, enrollXiaochan, fetchXiaochanEnrollmentUpdates } from "../server/utils/xiaochan-enrollment";
import { cancelXiaochanSchedule, runXiaochanSchedule, setXiaochanSchedule } from "../server/utils/xiaochan-schedules";
import { canScheduleEnrollment, defaultEnrollmentTime, todayEnrollmentWindow } from "../shared/utils/enrollment-time";
import { emptySession, publicSession, type LocalSession } from "../server/utils/session";
import type { xiaochanRpc } from "../server/utils/xiaochan-rpc";

const now = new Date("2026-11-06T04:00:00Z");
function session(): LocalSession {
  const data = emptySession();
  data.xiaochanAccount = { silkId: "123456789", userId: "6789", accessToken: "private-token" };
  data.connections.xiaochan = { state: "connected", label: "已登录" };
  data.location = { label: "测试地址", cityCode: 310100, latitude: 31.23, longitude: 121.47 };
  data.offers.xiaochan = [{
    id: "xiaochan:42", provider: "xiaochan", name: "测试店", category: "美食",
    inventory: 3, distanceMeters: 1000, startTime: "08:00", endTime: "23:59",
    requirement: "无需评价", rule: { kind: "fixed", thresholdCents: 2000, cashbackCents: 1500 },
    source: "live", collectedAt: now.toISOString(),
  }];
  return data;
}
const rpcWith = (run: (...args: Parameters<typeof xiaochanRpc>) => unknown) => run as typeof xiaochanRpc;

test("Xiaochan enrollment uses the selected live activity, authenticated identity and ordinary promotion contract", async () => {
  const data = session();
  let persisted = 0, requests = 0;
  data.offers.xiaochan.push({ ...data.offers.xiaochan[0]!, id: "xiaochan:43" });
  const result = await enrollXiaochan(data, "xiaochan:43", {
    now,
    persist: async () => { persisted++; },
    rpc: rpcWith(async request => {
      requests++;
      assert.equal(persisted, 1);
      assert.equal(data.xiaochanEnrollments?.["xiaochan:43"]?.state, "unknown");
      assert.equal(request.serverName, "Silkworm");
      assert.equal(request.methodName, "SilkwormService.GrabPromotionQuota");
      assert.equal(request.headers["x-teemo"], "123456789");
      assert.equal(request.headers["x-vayne"], "6789");
      assert.equal(request.headers["x-sivir"], "private-token");
      assert.deepEqual(request.body, {
        silk_id: 123456789, promotion_id: 43, store_platform: 1,
        if_advance_order: false, if_pre_order: false, city_code: 310100,
        longitude: 121.47, latitude: 31.23,
      });
      return { status: { code: 0 }, promotion_order_id: 9001 };
    }),
  });
  assert.equal(result.state, "enrolled");
  assert.equal(result.orderId, "9001");
  assert.equal(data.xiaochanEnrollments?.["xiaochan:42"], undefined);
  assert.equal(persisted, 2);
  assert.equal(requests, 1);
});

test("Xiaochan enrollment rejects guests, imported activities, invalid IDs and unavailable activities before any request", async () => {
  const cases: Array<(data: LocalSession) => void> = [
    data => { delete data.xiaochanAccount; },
    data => { data.connections.xiaochan.state = "configured"; },
    data => { data.xiaochanAccount!.expiresAt = now.getTime() - 1; },
    data => { data.xiaochanAccount!.silkId = "1234567890123"; },
    data => { data.offers.xiaochan[0]!.source = "import"; },
    data => { data.offers.xiaochan[0]!.provider = "waimai"; },
    data => { data.offers.xiaochan[0]!.inventory = 0; },
    data => { delete data.offers.xiaochan[0]!.inventory; },
    data => { data.offers.xiaochan[0]!.distanceMeters = 7001; },
    data => { data.offers.xiaochan[0]!.validFrom = "2026-11-07T00:00:00Z"; },
    data => { data.offers.xiaochan[0]!.validUntil = "2026-11-05T00:00:00Z"; },
    data => { data.offers.xiaochan[0]!.collectedAt = "2026-11-05T00:00:00Z"; },
    data => { data.location = null; },
  ];
  for (const mutate of cases) {
    const data = session(); mutate(data);
    await assert.rejects(enrollXiaochan(data, "xiaochan:42", {
      now, persist: async () => { assert.fail("Unexpected persistence"); },
      rpc: rpcWith(async () => { assert.fail("Unexpected enrollment"); }),
    }));
  }
  for (const id of [undefined, {}, "waimai:42", "xiaochan:0", "xiaochan:9007199254740993", "xiaochan:44"])
    await assert.rejects(enrollXiaochan(session(), id, {
      now, persist: async () => { assert.fail("Unexpected persistence"); },
      rpc: rpcWith(async () => { assert.fail("Unexpected enrollment"); }),
    }));
});

test("Confirmed enrollment is idempotent and never claims a second quota", async () => {
  const data = session();
  data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9001", updatedAt: now.toISOString() } };
  const result = await enrollXiaochan(data, "xiaochan:42", {
    now, persist: async () => { assert.fail("Unexpected persistence"); },
    rpc: rpcWith(async () => { assert.fail("Unexpected repeat"); }),
  });
  assert.equal(result.orderId, "9001");
});

test("Uncertain quota response is retained and repeat attempts are rejected without retrying upstream", async () => {
  for (const response of [null, {}, { status: { code: 0 } }, { status: { code: null }, promotion_order_id: 9001 }, { status: { code: 0 }, promotion_order_id: "0" }, { status: { code: 0 }, promotion_order_id: 9007199254740992 }]) {
    const data = session(); let calls = 0, detailCalls = 0;
    const options = { now, persist: async () => {}, rpc: rpcWith(async request => {
      if (request.methodName === "SilkwormService.GetStorePromotionDetail") { detailCalls++; return {}; }
      calls++; return response;
    }) };
    await assert.rejects(enrollXiaochan(data, "xiaochan:42", options), /报名待确认/);
    assert.equal(data.xiaochanEnrollments?.["xiaochan:42"]?.state, "unknown");
    await assert.rejects(enrollXiaochan(data, "xiaochan:42", options), (error: any) => error.statusCode === 409);
    assert.equal(calls, 1);
    assert.equal(detailCalls, 1);
  }
  const data = session();
  await assert.rejects(enrollXiaochan(data, "xiaochan:42", {
    now, persist: async () => {}, rpc: rpcWith(async () => { throw new Error("private-network-error"); }),
  }), (error: any) => error.statusCode === 502 && error.statusMessage === "报名待确认" && !error.message.includes("private-network-error"));
  assert.equal(data.xiaochanEnrollments?.["xiaochan:42"]?.state, "unknown");
});

test("Unknown enrollment can only be confirmed by a matching activity record without requesting another quota", async () => {
  const data = session(); let persisted = 0;
  data.xiaochanEnrollments = { "xiaochan:42": { state: "unknown", updatedAt: now.toISOString() } };
  data.offers.xiaochan[0]!.inventory = 0;
  data.offers.xiaochan[0]!.validUntil = "2026-11-05T00:00:00Z";
  const result = await enrollXiaochan(data, "xiaochan:42", {
    now, persist: async () => { persisted++; }, rpc: rpcWith(async request => {
      assert.equal(request.methodName, "SilkwormService.GetStorePromotionDetail");
      assert.equal(request.serverName, "Silkworm");
      assert.deepEqual(request.body, { silk_id: 123456789, promotion_id: 42 });
      return { status: { code: 0 }, promotion_detail: { promotion_id: 42, meituan_status: 1 }, order_list: [{ store_platform: 1, promotion_order_id: 9042, order_status: 0 }] };
    }),
  });
  assert.equal(result.state, "enrolled");
  assert.equal(result.orderId, "9042");
  assert.equal(persisted, 1);
});

test("Lookup never confirms another activity, platform, affiliate record or an ambiguous order", async () => {
  const valid = { status: { code: 0 }, promotion_detail: { promotion_id: 42, meituan_status: 1 }, order_list: [{ store_platform: 1, promotion_order_id: 9042, order_status: 0 }] };
  for (const response of [
    { ...valid, promotion_detail: { ...valid.promotion_detail, promotion_id: 43 } },
    { ...valid, promotion_detail: { ...valid.promotion_detail, meituan_status: 0 } },
    { ...valid, order_list: [{ ...valid.order_list[0], store_platform: 2 }] },
    { ...valid, order_list: [{ ...valid.order_list[0], order_status: 4 }] },
    { ...valid, order_list: [{ ...valid.order_list[0], order_status: 5 }] },
    { ...valid, order_list: [{ ...valid.order_list[0], order_status: null }] },
    { ...valid, order_list: [{ ...valid.order_list[0], order_status: 99 }] },
    { ...valid, order_list: [{ ...valid.order_list[0], promotion_order_id: 0 }] },
    { ...valid, order_list: [{ ...valid.order_list[0], promotion_order_id: undefined }] },
    { ...valid, order_list: [valid.order_list[0], valid.order_list[0]] },
    { ...valid, status: { code: null } }, {},
  ]) {
    const data = session();
    data.xiaochanEnrollments = { "xiaochan:42": { state: "unknown", updatedAt: now.toISOString() } };
    await assert.rejects(enrollXiaochan(data, "xiaochan:42", {
      now, persist: async () => { assert.fail("Unexpected confirmation"); }, rpc: rpcWith(async request => {
        assert.equal(request.methodName, "SilkwormService.GetStorePromotionDetail");
        return response;
      }),
    }), (error: any) => error.statusCode === 409);
    assert.equal(data.xiaochanEnrollments["xiaochan:42"]?.state, "unknown");
  }
});

test("Lookup network failures preserve unknown state and confirmed login expiry persists expired state", async () => {
  for (const expired of [false, true]) {
    const data = session(); let persisted = 0;
    data.xiaochanEnrollments = { "xiaochan:42": { state: "unknown", updatedAt: now.toISOString() } };
    await assert.rejects(enrollXiaochan(data, "xiaochan:42", {
      now, persist: async () => { persisted++; }, rpc: rpcWith(async request => {
        assert.equal(request.methodName, "SilkwormService.GetStorePromotionDetail");
        if (expired) throw createError({ statusCode: 401, statusMessage: "登录已失效", data: { xiaochanOutcome: "rejected" } });
        throw new Error("private-lookup-error");
      }),
    }), (error: any) => error.statusCode === (expired ? 401 : 409));
    assert.equal(data.xiaochanEnrollments["xiaochan:42"]?.state, "unknown");
    assert.equal(data.connections.xiaochan.state, expired ? "expired" : "connected");
    assert.equal(persisted, expired ? 1 : 0);
  }
});

test("Explicit upstream rejection removes the uncertain attempt without marking it successful", async () => {
  const data = session(); let persisted = 0;
  await assert.rejects(enrollXiaochan(data, "xiaochan:42", {
    now, persist: async () => { persisted++; }, rpc: rpcWith(async () => {
      throw createError({ statusCode: 502, statusMessage: "活动报名失败", data: { xiaochanOutcome: "rejected" } });
    }),
  }), /活动报名失败/);
  assert.equal(data.xiaochanEnrollments?.["xiaochan:42"], undefined);
  assert.equal(persisted, 2);
});

test("Expired native login is reflected in account state after confirmed rejection", async () => {
  const data = session();
  await assert.rejects(enrollXiaochan(data, "xiaochan:42", {
    now, persist: async () => {}, rpc: rpcWith(async () => {
      throw createError({ statusCode: 401, statusMessage: "登录已失效", data: { xiaochanOutcome: "rejected" } });
    }),
  }));
  assert.equal(data.connections.xiaochan.state, "expired");
  assert.equal(data.xiaochanEnrollments?.["xiaochan:42"], undefined);
});

test("Failure to persist the attempt prevents any quota request", async () => {
  const data = session();
  await assert.rejects(enrollXiaochan(data, "xiaochan:42", {
    now, persist: async () => { throw new Error("Storage failed"); },
    rpc: rpcWith(async () => { assert.fail("Unexpected quota request"); }),
  }), /Storage failed/);
  assert.equal(data.xiaochanEnrollments?.["xiaochan:42"], undefined);
});

test("Sync removes confirmed cancelled orders and retains other enrolled activity tiers", async () => {
  for (const cancelledState of [4, 5, 7]) {
    const data = session();
    data.offers.xiaochan.push({ ...data.offers.xiaochan[0]!, id: "xiaochan:43" });
    data.xiaochanEnrollments = {
      "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() },
      "xiaochan:43": { state: "enrolled", orderId: "9043", updatedAt: now.toISOString() },
    };
    // Older saved activity payloads can also carry the previous public state.
    data.offers.xiaochan[0]!.enrollment = { state: "enrolled", orderId: "9042" };
    const { updates, errors } = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
      now, rpc: rpcWith(async request => {
        assert.equal(request.methodName, "SilkwormService.GetPromotionOrderList");
        assert.deepEqual(request.body, { silk_id: 123456789, ids: [9042, 9043], number: 20 });
        return { status: { code: 0 }, order_list: [
          { promotion_order_id: 9042, store_platform: 1, order_status: cancelledState },
          { promotion_order_id: "9043", store_platform: "1", order_status: "0" },
        ] };
      }),
    });
    assert.deepEqual(errors, []);
    applyXiaochanEnrollmentUpdates(data, structuredClone(data), updates);
    assert.equal(data.xiaochanEnrollments["xiaochan:42"], undefined);
    const visible = publicSession(data).offers.xiaochan;
    assert.equal(visible[0]!.enrollment, undefined);
    assert.deepEqual(visible[1]!.enrollment, { state: "enrolled", orderId: "9043" });
  }
});

test("Sync cannot clear enrollment from an absent, mismatched, ambiguous or unknown official record", async () => {
  const valid = { promotion_order_id: 9042, store_platform: 1, order_status: 4 };
  for (const response of [
    {}, { status: { code: 0 } }, { status: { code: 0 }, order_list: [] },
    { status: { code: 0 }, order_list: [{ ...valid, promotion_order_id: 9043 }] },
    { status: { code: 0 }, order_list: [{ ...valid, store_platform: 2 }] },
    { status: { code: 0 }, order_list: [valid, valid] },
    { status: { code: 0 }, order_list: [{ ...valid, order_status: 99 }] },
  ]) {
    const data = session();
    data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() } };
    const { updates, errors } = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
      now, rpc: rpcWith(async () => response),
    });
    assert.deepEqual(updates, {});
    assert.deepEqual(errors, ["小蚕报名状态同步失败，请重试"]);
  }
});

test("Sync lookup failures preserve enrollment and propagate confirmed account expiry", async () => {
  const data = session();
  data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() } };
  const result = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
    now, rpc: rpcWith(async () => { throw new Error("Network failure"); }),
  });
  assert.deepEqual(result.updates, {});
  assert.equal(data.xiaochanEnrollments["xiaochan:42"]?.state, "enrolled");
  assert.equal(result.errors.length, 1);
  await assert.rejects(fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
    now, rpc: rpcWith(async () => { throw createError({ statusCode: 401 }); }),
  }), (error: any) => error.statusCode === 401);
});

test("Older cancellation lookup cannot overwrite a new enrollment made during sync", () => {
  const data = session();
  data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() } };
  const snapshot = structuredClone(data);
  data.xiaochanEnrollments["xiaochan:42"] = { state: "enrolled", orderId: "10042", updatedAt: new Date(now.getTime() + 1000).toISOString() };
  applyXiaochanEnrollmentUpdates(data, snapshot, { "xiaochan:42": null });
  assert.equal(data.xiaochanEnrollments["xiaochan:42"]?.orderId, "10042");
});

test("Sync confirms uncertain enrollment through detail lookup without claiming quota", async () => {
  const data = session();
  data.xiaochanEnrollments = { "xiaochan:42": { state: "unknown", updatedAt: now.toISOString() } };
  const { updates, errors } = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
    now, rpc: rpcWith(async request => {
      assert.equal(request.methodName, "SilkwormService.GetStorePromotionDetail");
      return { status: { code: 0 }, promotion_detail: { promotion_id: 42, meituan_status: 1 },
        order_list: [{ promotion_order_id: 9042, store_platform: 1, order_status: 0 }] };
    }),
  });
  assert.deepEqual(errors, []);
  assert.equal(updates["xiaochan:42"]?.state, "enrolled");
});

test("Sync bounds order lookups to batches of 20 without querying untracked activities", async () => {
  const data = session();
  data.xiaochanEnrollments = {};
  data.offers.xiaochan = Array.from({ length: 21 }, (_, i) => {
    const offer = { ...session().offers.xiaochan[0]!, id: `xiaochan:${i + 42}` };
    data.xiaochanEnrollments![offer.id] = { state: "enrolled", orderId: String(i + 9042), updatedAt: now.toISOString() };
    return offer;
  });
  let requests = 0;
  const result = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
    now, rpc: rpcWith(async request => {
      requests++;
      const ids = request.body.ids as number[];
      assert.equal(ids.length, requests === 1 ? 20 : 1);
      return { status: { code: 0 }, order_list: ids.map(id => ({ promotion_order_id: id, store_platform: 1, order_status: 4 })) };
    }),
  });
  assert.equal(requests, 2);
  assert.equal(Object.keys(result.updates).length, 21);
  const empty = await fetchXiaochanEnrollmentUpdates(session(), session().offers.xiaochan, {
    rpc: rpcWith(async () => assert.fail("Unexpected lookup")),
  });
  assert.deepEqual(empty, { updates: {}, errors: [] });
});

const queryBlocks = [
  { statusCode: 502, statusMessage: "小蚕请求被拦截，请稍后重试", data: { xiaochanOutcome: "rejected", xiaochanFailure: "gateway-blocked" } },
  { statusCode: 429, statusMessage: "小蚕请求频繁，请稍后重试", data: { xiaochanOutcome: "rejected" } },
];

function trackedSession(count: number, state: "enrolled" | "unknown" = "enrolled") {
  const data = session();
  data.xiaochanEnrollments = {};
  data.offers.xiaochan = Array.from({ length: count }, (_, i) => {
    const offer = { ...session().offers.xiaochan[0]!, id: `xiaochan:${i + 42}` };
    data.xiaochanEnrollments![offer.id] = {
      state, ...(state === "enrolled" ? { orderId: String(i + 9042) } : {}),
      updatedAt: new Date(now.getTime() - 10_000).toISOString(),
    };
    return offer;
  });
  return data;
}

test("Sync stops remaining order batches and unknown lookups after a gateway block or rate limit", async () => {
  for (const block of queryBlocks) {
    const data = trackedSession(41);
    data.offers.xiaochan.push({ ...data.offers.xiaochan[0]!, id: "xiaochan:100" });
    data.xiaochanEnrollments!["xiaochan:100"] = { state: "unknown", updatedAt: now.toISOString() };
    const original = structuredClone(data);
    let calls = 0;
    const result = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
      now, rpc: rpcWith(async request => {
        calls++;
        assert.equal(request.methodName, "SilkwormService.GetPromotionOrderList");
        throw createError(block);
      }),
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { updates: {}, errors: [block.statusMessage] });
    assert.deepEqual(data, original);
  }
});

test("Sync retains confirmed updates when a later order batch is blocked", async () => {
  for (const block of queryBlocks) {
    const data = trackedSession(41);
    const original = structuredClone(data);
    let calls = 0;
    const result = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
      now, rpc: rpcWith(async request => {
        if (++calls > 1) throw createError(block);
        const ids = request.body.ids as number[];
        return { status: { code: 0 }, order_list: ids.map((id, i) => ({
          promotion_order_id: id, store_platform: 1, order_status: i === 0 ? 4 : 0,
        })) };
      }),
    });
    assert.equal(calls, 2);
    assert.equal(Object.keys(result.updates).length, 20);
    assert.equal(result.updates["xiaochan:42"], null);
    assert.deepEqual(result.updates["xiaochan:43"], { ...original.xiaochanEnrollments!["xiaochan:43"], updatedAt: now.toISOString() });
    assert.equal(result.updates["xiaochan:62"], undefined);
    assert.deepEqual(result.errors, [block.statusMessage]);
    assert.deepEqual(data, original);
  }
});

test("Sync preserves and deduplicates earlier lookup errors when a later batch is blocked", async () => {
  for (const block of queryBlocks) {
    const data = trackedSession(41);
    const original = structuredClone(data);
    let calls = 0;
    const result = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
      now, rpc: rpcWith(async () => {
        if (++calls > 1) throw createError(block);
        return { status: { code: 0 }, order_list: [] };
      }),
    });
    assert.equal(calls, 2);
    assert.deepEqual(result, {
      updates: {}, errors: ["小蚕报名状态同步失败，请重试", block.statusMessage],
    });
    assert.deepEqual(data, original);
  }
});

test("Sync stops unknown detail lookups on a block without changing pending enrollment state", async () => {
  for (const block of queryBlocks) {
    for (const successfulLookups of [0, 1]) {
      const data = trackedSession(3, "unknown");
      const original = structuredClone(data);
      let calls = 0;
      const result = await fetchXiaochanEnrollmentUpdates(data, data.offers.xiaochan, {
        now, rpc: rpcWith(async request => {
          assert.equal(request.methodName, "SilkwormService.GetStorePromotionDetail");
          if (++calls > successfulLookups) throw createError(block);
          return { status: { code: 0 }, promotion_detail: { promotion_id: request.body.promotion_id, meituan_status: 1 },
            order_list: [{ promotion_order_id: 9042, store_platform: 1, order_status: 0 }] };
        }),
      });
      assert.equal(calls, successfulLookups + 1);
      assert.equal(Object.keys(result.updates).length, successfulLookups);
      if (successfulLookups) assert.deepEqual(result.updates["xiaochan:42"], { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() });
      assert.deepEqual(result.errors, [block.statusMessage]);
      assert.deepEqual(data, original);
    }
  }
});

test("Unknown enrollment lookup preserves a blocking error without persisting or retrying", async () => {
  for (const block of queryBlocks) {
    const data = trackedSession(1, "unknown"), original = structuredClone(data);
    const failure = createError(block);
    let calls = 0;
    await assert.rejects(enrollXiaochan(data, "xiaochan:42", {
      now, persist: async () => assert.fail("Unexpected persistence"), rpc: rpcWith(async () => {
        calls++;
        throw failure;
      }),
    }), error => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(data, original);
  }
});

test("Cancellation targets the saved order and clears only after official confirmation", async () => {
  const data = session();
  data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() } };
  let cancelled = false, persisted = 0;
  const requests: string[] = [];
  await cancelXiaochanEnrollment(data, "xiaochan:42", {
    now, persist: async () => { persisted++; }, rpc: rpcWith(async request => {
      requests.push(request.methodName);
      if (request.methodName === "SilkwormService.CancelPromotionQuota") {
        assert.equal(data.xiaochanEnrollments!["xiaochan:42"]?.state, "cancel-unknown");
        assert.equal(persisted, 1);
        assert.deepEqual(request.body, { silk_id: 123456789, promotion_order_id: 9042 });
        cancelled = true;
        return { status: { code: 0 } };
      }
      assert.deepEqual(request.body, { silk_id: 123456789, ids: [9042], number: 20 });
      return { status: { code: 0 }, order_list: [{ promotion_order_id: 9042, store_platform: 1, order_status: cancelled ? 4 : 0 }] };
    }),
  });
  assert.deepEqual(requests, ["SilkwormService.GetPromotionOrderList", "SilkwormService.CancelPromotionQuota", "SilkwormService.GetPromotionOrderList"]);
  assert.equal(data.xiaochanEnrollments["xiaochan:42"], undefined);
  assert.equal(persisted, 2);
});

test("Cancellation refuses unverified or completed orders without changing them", async () => {
  for (const order of [
    { promotion_order_id: 9043, store_platform: 1, order_status: 0 },
    { promotion_order_id: 9042, store_platform: 2, order_status: 0 },
    { promotion_order_id: 9042, store_platform: 1, order_status: 2 },
  ]) {
    const data = session();
    data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() } };
    await assert.rejects(cancelXiaochanEnrollment(data, "xiaochan:42", {
      now, persist: async () => assert.fail("Unexpected mutation"), rpc: rpcWith(async request => {
        assert.equal(request.methodName, "SilkwormService.GetPromotionOrderList");
        return { status: { code: 0 }, order_list: [order] };
      }),
    }));
    assert.equal(data.xiaochanEnrollments["xiaochan:42"]?.state, "enrolled");
  }
});

test("Lost cancellation responses can be confirmed without a repeated cancellation request", async () => {
  for (const confirmed of [true, false]) {
    const data = session();
    data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() } };
    let cancels = 0;
    const options = { now, persist: async () => {}, rpc: rpcWith(async request => {
      if (request.methodName === "SilkwormService.CancelPromotionQuota") {
        cancels++; throw new Error("Lost response");
      }
      return { status: { code: 0 }, order_list: [{ promotion_order_id: 9042, store_platform: 1, order_status: cancels && confirmed ? 4 : 0 }] };
    }) };
    if (confirmed) await cancelXiaochanEnrollment(data, "xiaochan:42", options);
    else {
      await assert.rejects(cancelXiaochanEnrollment(data, "xiaochan:42", options), /取消待确认/);
      assert.equal(data.xiaochanEnrollments["xiaochan:42"]?.state, "cancel-unknown");
      await assert.rejects(cancelXiaochanEnrollment(data, "xiaochan:42", options), /取消待确认/);
      await assert.rejects(enrollXiaochan(data, "xiaochan:42", options), /取消待确认/);
    }
    assert.equal(cancels, 1);
  }
});

test("Explicit cancellation rejection restores enrollment and persists account expiry", async () => {
  for (const expired of [true, false]) {
    const data = session();
    data.xiaochanEnrollments = { "xiaochan:42": { state: "enrolled", orderId: "9042", updatedAt: now.toISOString() } };
    await assert.rejects(cancelXiaochanEnrollment(data, "xiaochan:42", {
      now, persist: async () => {}, rpc: rpcWith(async request => {
        if (request.methodName === "SilkwormService.CancelPromotionQuota")
          throw createError({ statusCode: expired ? 401 : 400, data: { xiaochanOutcome: "rejected" } });
        return { status: { code: 0 }, order_list: [{ promotion_order_id: 9042, store_platform: 1, order_status: 0 }] };
      }),
    }));
    assert.equal(data.xiaochanEnrollments["xiaochan:42"]?.state, "enrolled");
    assert.equal(data.connections.xiaochan.state, expired ? "expired" : "connected");
  }
});

test("Schedule time defaults to the exact activity opening time in Shanghai", () => {
  const offer = session().offers.xiaochan[0]!;
  offer.startTime = "13:00";
  assert.equal(defaultEnrollmentTime(offer, new Date("2026-11-06T04:59:50Z")), "2026-11-06T13:00:00");
  const start = new Date("2026-11-06T05:00:00Z");
  assert.equal(canScheduleEnrollment(offer, start, now), true);
  assert.equal(canScheduleEnrollment(offer, new Date(start.getTime() - 1), now), false);
  assert.equal(canScheduleEnrollment(offer, now, now), false);
  assert.equal(canScheduleEnrollment(offer, new Date("2026-11-07T05:00:00Z"), now), false);
  offer.validFrom = "2026-11-07T00:00:00Z";
  offer.startTime = "08:00";
  assert.equal(canScheduleEnrollment(offer, new Date(offer.validFrom), now), false);
  assert.equal(defaultEnrollmentTime(offer, now), "");
  offer.validFrom = "invalid";
  assert.equal(canScheduleEnrollment(offer, start, now), false);
});

test("Today's schedule window excludes past times, later dates and the activity end", () => {
  const offer = { ...session().offers.xiaochan[0]!, startTime: "13:00", endTime: "14:00" };
  assert.deepEqual(todayEnrollmentWindow(offer, now), { start: Date.parse("2026-11-06T05:00:00Z"), end: Date.parse("2026-11-06T06:00:00Z") });
  assert.equal(canScheduleEnrollment(offer, new Date("2026-11-06T05:59:59Z"), now), true);
  assert.equal(canScheduleEnrollment(offer, new Date("2026-11-06T06:00:00Z"), now), false);
  assert.equal(canScheduleEnrollment(offer, new Date("2026-11-07T05:30:00Z"), now), false);
  assert.equal(canScheduleEnrollment(offer, now, now), false);
  assert.equal(todayEnrollmentWindow(offer, new Date("2026-11-06T06:00:00Z")), undefined);
  offer.validUntil = "2026-11-06T05:30:00Z";
  assert.equal(todayEnrollmentWindow(offer, now)?.end, Date.parse(offer.validUntil));
  assert.equal(todayEnrollmentWindow({ ...offer, startTime: undefined, validUntil: undefined }, now)?.end, Date.parse("2026-11-06T06:00:00Z"));
  const allDay = { ...offer, validUntil: undefined, startTime: "00:00", endTime: "24:00" };
  const late = new Date("2026-11-06T15:59:50Z");
  assert.equal(canScheduleEnrollment(allDay, new Date("2026-11-06T15:59:59Z"), late), true);
  assert.equal(canScheduleEnrollment(allDay, new Date("2026-11-06T16:00:00Z"), late), false);
});

test("Scheduled enrollment stays idle before its deadline and submits exactly once at the deadline", async () => {
  const data = session();
  const deadline = new Date(now.getTime() + 1000);
  setXiaochanSchedule(data, "xiaochan:42", deadline.toISOString(), now);
  assert.equal(publicSession(data).enrollmentSchedules?.[0]?.runAt, deadline.toISOString());
  let requests = 0, persisted = 0;
  const options = { persist: async () => { persisted++; }, rpc: rpcWith(async request => {
    requests++;
    assert.equal(request.methodName, "SilkwormService.GrabPromotionQuota");
    assert.ok(persisted >= 2);
    return { status: { code: 0 }, promotion_order_id: 9042 };
  }) };
  await runXiaochanSchedule(data, "xiaochan:42", { ...options, now });
  assert.equal(requests, 0);
  // A later feed may have omitted the selected activity; its saved tier remains executable.
  data.offers.xiaochan = [];
  await runXiaochanSchedule(data, "xiaochan:42", { ...options, now: deadline });
  await runXiaochanSchedule(data, "xiaochan:42", { ...options, now: deadline });
  assert.equal(requests, 1);
  assert.equal(data.xiaochanEnrollments?.["xiaochan:42"]?.state, "enrolled");
  assert.equal(data.xiaochanSchedules?.["xiaochan:42"], undefined);
  assert.throws(() => cancelXiaochanSchedule(data, "xiaochan:42"), /报名已执行/);
});

test("Cancelled, stale, account-changed and address-changed schedules cannot claim quota", async () => {
  for (const mode of ["cancel", "late", "account", "address"]) {
    const data = session(), deadline = new Date(now.getTime() + 1000);
    setXiaochanSchedule(data, "xiaochan:42", deadline.toISOString(), now);
    if (mode === "cancel") cancelXiaochanSchedule(data, "xiaochan:42");
    if (mode === "account") data.xiaochanAccount!.userId = "9999";
    if (mode === "address") data.location!.label = "其他地址";
    await runXiaochanSchedule(data, "xiaochan:42", {
      now: new Date(deadline.getTime() + (mode === "late" ? 61_000 : 0)),
      persist: async () => {}, rpc: rpcWith(async () => assert.fail("Unexpected quota request")),
    });
    assert.equal(data.xiaochanSchedules?.["xiaochan:42"]?.state, mode === "cancel" ? undefined : "failed");
  }
});

test("Uncertain scheduled quota requests retain lookup state and are never replayed", async () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  setXiaochanSchedule(data, "xiaochan:42", deadline.toISOString(), now);
  let requests = 0;
  const options = { now: deadline, persist: async () => {}, rpc: rpcWith(async () => { requests++; throw new Error("Network failure"); }) };
  await runXiaochanSchedule(data, "xiaochan:42", options);
  await runXiaochanSchedule(data, "xiaochan:42", options);
  assert.equal(requests, 1);
  assert.equal(data.xiaochanSchedules?.["xiaochan:42"]?.state, "failed");
  assert.equal(data.xiaochanEnrollments?.["xiaochan:42"]?.state, "unknown");
});

test("Invalid schedules and persistence failures cannot start a quota request", async () => {
  const data = session(), deadline = new Date(now.getTime() + 1000);
  for (const time of [now.toISOString(), "invalid", "2026-11-08T04:00:00Z"])
    assert.throws(() => setXiaochanSchedule(data, "xiaochan:42", time, now));
  data.xiaochanEnrollments = { "xiaochan:42": { state: "unknown", updatedAt: now.toISOString() } };
  assert.throws(() => setXiaochanSchedule(data, "xiaochan:42", deadline.toISOString(), now));
  delete data.xiaochanEnrollments;
  setXiaochanSchedule(data, "xiaochan:42", deadline.toISOString(), now);
  await assert.rejects(runXiaochanSchedule(data, "xiaochan:42", {
    now: deadline, persist: async () => { throw new Error("Storage failed"); }, rpc: rpcWith(async () => assert.fail("Unexpected quota request")),
  }));
  assert.equal(data.xiaochanSchedules?.["xiaochan:42"]?.state, "scheduled");
});
