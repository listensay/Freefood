import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent } from "h3";
import { isAllowedHost, isAllowedPeer } from "../server/utils/network";
import { assertLocalRequest, sessionId } from "../server/utils/session";
import { assertRequestAccess } from "../server/utils/request-access";

function event(
  headers: Record<string, string> = {},
  peer = "127.0.0.1",
  method = "GET",
) {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: peer,
    configurable: true,
  });
  const request = new IncomingMessage(socket);
  request.url = "/api/dashboard";
  request.method = method;
  request.headers = { host: "127.0.0.1:3000", ...headers };
  return createEvent(request, new ServerResponse(request));
}

function withLan(enabled: boolean, task: () => void) {
  const previous = process.env.FOOD_ALLOW_LAN;
  process.env.FOOD_ALLOW_LAN = enabled ? "1" : "0";
  try {
    task();
  } finally {
    if (previous === undefined) delete process.env.FOOD_ALLOW_LAN;
    else process.env.FOOD_ALLOW_LAN = previous;
  }
}

test("local mode accepts loopback hosts and peers, not LAN addresses", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "127.1.2.3"])
    assert.equal(isAllowedHost(host, false), true);
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    assert.equal(isAllowedPeer(peer, false), true);
  assert.equal(isAllowedHost("192.168.1.20", false), false);
  assert.equal(isAllowedPeer("192.168.1.20", false), false);
});

test("LAN mode accepts RFC1918, link-local, ULA and mapped IPv4 addresses", () => {
  for (const address of [
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.20",
    "169.254.1.2",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "fe80::1%en0",
    "::ffff:192.168.1.20",
    "::ffff:c0a8:114",
  ])
    assert.equal(isAllowedPeer(address, true), true, address);
  for (const host of ["192.168.1.20", "[fd12::1]", "[fe80::1]"])
    assert.equal(isAllowedHost(host, true), true);
});

test("LAN mode rejects public addresses, malformed addresses, arbitrary domains and unknown peers", () => {
  for (const value of [
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "2001:4860:4860::8888",
    "fec0::1",
    "::",
    "999.1.1.1",
    "10.evil.example",
    "example.com",
    "",
  ]) {
    assert.equal(isAllowedHost(value, true), false, value);
    assert.equal(isAllowedPeer(value, true), false, value);
  }
  assert.equal(isAllowedPeer(undefined, true), false);
});

test("request access requires both an allowed host and a real allowed socket peer", () => {
  withLan(false, () => {
    assertLocalRequest(event());
    assert.throws(
      () => assertLocalRequest(event({ host: "192.168.1.20:3000" })),
      { statusCode: 403 },
    );
    assert.throws(() => assertLocalRequest(event({}, "192.168.1.20")), {
      statusCode: 403,
    });
  });
  withLan(true, () => {
    const request = event({ host: "192.168.1.20:3000" }, "192.168.1.21");
    assertLocalRequest(request);
    assert.equal(request.node.res.getHeader("cache-control"), "no-store");
    assert.throws(
      () =>
        assertLocalRequest(
          event({ "x-forwarded-for": "192.168.1.20" }, "8.8.8.8"),
        ),
      { statusCode: 403 },
    );
  });
});

test("LAN mode retains same-origin, fetch-site and mutation header checks", () => {
  withLan(true, () => {
    const valid = {
      host: "192.168.1.20:3000",
      origin: "http://192.168.1.20:3000",
      "x-food-request": "1",
    };
    assertLocalRequest(event(valid, "192.168.1.21", "POST"));
    assert.throws(
      () =>
        assertLocalRequest(
          event(
            { ...valid, origin: "http://192.168.1.20:3001" },
            "192.168.1.21",
            "POST",
          ),
        ),
      { statusCode: 403 },
    );
    assert.throws(
      () =>
        assertLocalRequest(
          event(
            { ...valid, origin: "https://evil.example" },
            "192.168.1.21",
            "POST",
          ),
        ),
      { statusCode: 403 },
    );
    assert.throws(
      () =>
        assertLocalRequest(
          event(
            { ...valid, "sec-fetch-site": "cross-site" },
            "192.168.1.21",
            "POST",
          ),
        ),
      { statusCode: 403 },
    );
    assert.throws(
      () =>
        assertLocalRequest(
          event({ ...valid, "x-food-request": "" }, "192.168.1.21", "POST"),
        ),
      { statusCode: 403 },
    );
  });
});

test("forwarded headers cannot override the host, origin or cookie transport security", () => {
  withLan(true, () => {
    assert.throws(
      () =>
        assertLocalRequest(
          event({ host: "evil.example", "x-forwarded-host": "localhost:3000" }),
        ),
      { statusCode: 403 },
    );
    assert.throws(
      () =>
        assertLocalRequest(
          event({
            "x-forwarded-proto": "https",
            origin: "https://127.0.0.1:3000",
          }),
        ),
      { statusCode: 403 },
    );
    const request = event({
      "x-forwarded-proto": "https",
      origin: "http://127.0.0.1:3000",
    });
    sessionId(request);
    const cookie = String(request.node.res.getHeader("set-cookie"));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /; Secure/);
  });
});

test("only the private dev Unix socket can skip the peer check after the entry guard", () => {
  withLan(true, () => {
    const request = event({ host: "192.168.1.20:3000" });
    Object.defineProperties(request.node.req.socket, {
      remoteAddress: { value: undefined },
      readable: { value: true },
      writable: { value: true },
    });
    const previous = process.env.NITRO_DEV_WORKER_ID;
    process.env.NITRO_DEV_WORKER_ID = "1";
    try {
      assert.throws(() => assertRequestAccess(request), { statusCode: 403 });
      assertRequestAccess(request, true);
      assert.throws(() => assertRequestAccess(event({}, "8.8.8.8"), true), {
        statusCode: 403,
      });
    } finally {
      if (previous === undefined) delete process.env.NITRO_DEV_WORKER_ID;
      else process.env.NITRO_DEV_WORKER_ID = previous;
    }
  });
});
