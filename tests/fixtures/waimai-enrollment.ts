import assert from "node:assert/strict";
import { constants, createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt } from "node:crypto";
import type { WaimaiAccount } from "../../server/utils/waimai";

export const waimaiTestAccount: WaimaiAccount = { userId: "20261107120000-test_user", uid: "123456789012345678", token: "waimai-enrollment-test-token" };
export const waimaiTestLocation = { label: "测试地址", cityCode: 310100, cityName: "上海市", latitude: 31.23, longitude: 121.47 };
const serverKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const clientKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const legacyKey = "jnd674751fh6fkgu";
const encrypt = (text: string, key: string) => {
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, Buffer.from(key), null);
  return Buffer.concat([cipher.update(text), cipher.final()]).toString("base64");
};
const decrypt = (text: string, key: string) => {
  const cipher = createDecipheriv(`aes-${key.length * 8}-ecb`, Buffer.from(key), null);
  return Buffer.concat([cipher.update(Buffer.from(text, "base64")), cipher.final()]).toString();
};

export interface WaimaiTestRequest {
  operation: "config" | "list" | "signup" | "cancel";
  body: Record<string, any>;
  headers: Headers;
}

export function createWaimaiTransport(
  handle: (request: WaimaiTestRequest) => unknown | Promise<unknown>,
  { account = waimaiTestAccount, city = waimaiTestLocation.cityName }: { account?: WaimaiAccount; city?: string } = {},
) {
  const calls: WaimaiTestRequest[] = [];
  const urls: Record<string, WaimaiTestRequest["operation"]> = {
    "https://fz-gateway.waimaimingtang.com/api/api/v2/index/newServiceConfig": "config",
    "https://fz-gateway.waimaimingtang.com/api/api/v2/overbearfood/api_overbear_orders_list": "list",
    "https://fz-gateway.waimaimingtang.com/api/api/v2/overbearfood/api_overbear_cancel_sign_up": "cancel",
    "https://wmapp-api-v2.waimaimingtang.com/api/order/waimaimt-web-order/overbear/signup": "signup",
  };
  const transport: typeof fetch = async (url, init) => {
    const operation = urls[String(url)];
    assert.ok(operation, `Unexpected request: ${String(url)}`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("application"), "overbear_one");
    assert.equal(headers.get("token"), account.token);
    assert.equal(headers.get("city"), encodeURIComponent(city));
    assert.equal(headers.get("appversion"), "1.1.175");
    assert.equal(headers.get("content-type"), "application/json");
    assert.match(headers.get("nonce")!, /^[0-8]{16}$/);
    assert.equal(decrypt(headers.get("sign")!, "asdf545asdf4545d"), headers.get("timestamp")! + headers.get("nonce")!);
    let body: Record<string, any>;
    if (operation === "signup") {
      const block = privateDecrypt({ key: serverKeys.privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(headers.get("encrypt-key")!, "base64"));
      assert.equal(block[0], 0);
      assert.equal(block[1], 2);
      assert.ok(block.indexOf(0, 2) >= 10);
      const key = Buffer.from(block.subarray(block.indexOf(0, 2) + 1).toString(), "base64").toString();
      assert.match(key, /^[A-Za-z0-9]{32}$/);
      body = JSON.parse(decrypt(String(init?.body), key));
    } else {
      body = JSON.parse(decrypt(JSON.parse(String(init?.body)).json, legacyKey));
    }
    const request = { operation, body, headers };
    calls.push(request);
    if (operation === "config") {
      assert.deepEqual(body, { city });
      return Response.json({ code: 1, data: encrypt(JSON.stringify({
        publicKey: serverKeys.publicKey.export({ type: "spki", format: "pem" }),
        privateKey: clientKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
      }), legacyKey) });
    }
    const result = await handle(request);
    if (result instanceof Response) return result;
    if (operation === "signup") {
      const key = "0123456789abcdefghijklmnopqrstuv";
      const encryptedKey = publicEncrypt({ key: clientKeys.publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(Buffer.from(key).toString("base64"))).toString("base64");
      return new Response(encrypt(JSON.stringify(result), key), { headers: { "encrypt-key": encryptedKey } });
    }
    const outer = result as any;
    return Response.json(outer?.data !== undefined ? { ...outer, data: encrypt(JSON.stringify(outer.data), legacyKey) } : outer);
  };
  return { transport, calls };
}
