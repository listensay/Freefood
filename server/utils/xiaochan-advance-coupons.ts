import { createError } from "h3";
import type { LocationSettings } from "../../shared/types";
import {
  xiaochanAccountHeaders,
  xiaochanRpc,
  type XiaochanAccount,
} from "./xiaochan-rpc";

export interface XiaochanAdvanceCoupon {
  id: string;
  startsAt: number;
  expiresAt: number;
}

const pageSize = 20;
const maxPages = 100;
const invalidResponse = () =>
  createError({ statusCode: 502, statusMessage: "超前抢单券查询失败，请重试" });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function integer(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return;
  if (!/^(0|[1-9]\d*)$/.test(String(value))) return;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export async function fetchXiaochanAdvanceCoupons(
  account: XiaochanAccount,
  location: LocationSettings | null,
  {
    rpc = xiaochanRpc,
    now = new Date(),
  }: { rpc?: typeof xiaochanRpc; now?: Date } = {},
): Promise<XiaochanAdvanceCoupon[]> {
  const startsAt = now.getTime();
  if (!Number.isSafeInteger(startsAt)) throw invalidResponse();
  const headers = xiaochanAccountHeaders(account);
  if (account.expiresAt !== undefined && account.expiresAt <= startsAt)
    throw createError({
      statusCode: 401,
      statusMessage: "小蚕登录已失效，请重新登录",
    });
  const coupons = new Map<string, XiaochanAdvanceCoupon>();
  const seen = new Map<string, string>();
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await new Promise((resolve) => setTimeout(resolve, 6000));
    const result = await rpc({
      headers,
      serverName: "SilkwormCard",
      methodName: "SilkwormCardService.GetUserCardList",
      location,
      body: {
        silk_id: Number(account.silkId),
        status: 0,
        offset: page * pageSize,
        number: pageSize,
        card_types: [1],
      },
    });
    if (
      !isRecord(result) ||
      !isRecord(result.status) ||
      ![0, "0"].includes(result.status.code as number | string)
    )
      throw invalidResponse();
    // Empty repeated fields can be omitted from a successful RPC response.
    const rows =
      result.list === undefined &&
      Object.keys(result).every((key) => key === "status")
        ? []
        : result.list;
    if (!Array.isArray(rows) || rows.length > pageSize) throw invalidResponse();
    let added = 0;
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.card)) throw invalidResponse();
      const id = integer(row.id);
      const type = integer(row.card.card_type);
      const status = row.status === undefined ? 0 : integer(row.status);
      const expires = integer(row.expire_time);
      if (
        !id ||
        type === undefined ||
        status === undefined ||
        expires === undefined ||
        !Number.isSafeInteger(expires * 1000)
      )
        throw invalidResponse();
      const key = String(id);
      const signature = `${type}:${status}:${expires}`;
      if (seen.has(key) && seen.get(key) !== signature) throw invalidResponse();
      if (!seen.has(key)) added++;
      seen.set(key, signature);
      if (type !== 1 || status !== 0 || expires * 1000 <= startsAt) continue;
      // No activation timestamp is established by the card-list protocol.
      coupons.set(key, { id: key, startsAt, expiresAt: expires * 1000 });
    }
    if (page > 0 && rows.length > 0 && added === 0)
      throw createError({
        statusCode: 502,
        statusMessage: "超前抢单券分页未更新，请重试",
      });
    if (rows.length < pageSize) return [...coupons.values()];
  }
  throw createError({
    statusCode: 502,
    statusMessage: "超前抢单券未加载完整，请重试",
  });
}
