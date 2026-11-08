import { randomBytes } from "node:crypto";
import { desktopSessionId, sessionDatabase } from "./session-database";
import type { H3Event } from "h3";
import {
  createError,
  getCookie,
  setCookie,
  getRequestURL,
} from "h3";
import type { DashboardData, Provider, EnrollmentSchedule, Offer, LocationSettings } from "../../shared/types";
import { providers } from "../../shared/types";
import { assertRequestAccess } from "./request-access";
import type { XiaochanAccount } from "./xiaochan-rpc";
import type { WaimaiAccount } from "./waimai";

export interface LocalSession extends DashboardData {
  xiaochanAccount?: XiaochanAccount;
  xiaochanEnrollments?: Record<string, {
    state: "enrolled" | "unknown" | "cancel-unknown";
    orderId?: string;
    updatedAt: string;
    advanceOrder?: boolean;
  }>;
  xiaochanSchedules?: Record<string, EnrollmentSchedule & {
    offer: Offer;
    location: LocationSettings;
    accountId: string;
    advanceOrder?: boolean;
  }>;
  waimaiAccount?: WaimaiAccount;
  waimaiEnrollments?: Record<string, {
    state: "enrolled" | "unknown" | "cancel-unknown";
    orderId?: string;
    updatedAt: string;
  }>;
  waimaiSchedules?: Record<string, EnrollmentSchedule & {
    offer: Offer;
    location: LocationSettings;
    accountId: string;
  }>;
  meituanStorage?: unknown;
  meituanAccountId?: string;
  lastSync?: number;
  lastSyncByProvider?: Partial<Record<Provider, number>>;
}

const sessions = new Map<string, LocalSession>();
const locks = new Map<string, Promise<unknown>>();

export async function storedSessionIds(): Promise<string[]> {
  const database = await sessionDatabase();
  await database.importLegacy(database.directory);
  return database.ids();
}

export function assertLocalRequest(event: H3Event) {
  assertRequestAccess(event);
}

export function sessionId(event: H3Event): string {
  assertLocalRequest(event);
  if (process.env.FOOD_DESKTOP === "1") return desktopSessionId();
  let id = getCookie(event, "food-session");
  if (!id || !/^[a-f0-9]{64}$/.test(id)) {
    id = randomBytes(32).toString("hex");
    setCookie(event, "food-session", id, {
      httpOnly: true,
      sameSite: "strict",
      secure: getRequestURL(event, { xForwardedProto: false }).protocol === "https:",
      path: "/",
      maxAge: 30 * 86400,
    });
  }
  return id;
}

export function emptySession(): LocalSession {
  return {
    location: null,
    connections: {
      xiaochan: { state: "disconnected", label: "未连接" },
      waimai: { state: "disconnected", label: "未连接" },
      meituan: { state: "disconnected", label: "未登录" },
    },
    offers: { xiaochan: [], waimai: [], meituan: [] },
    updatedAt: {},
  };
}

export async function loadSession(id: string): Promise<LocalSession> {
  if (sessions.has(id)) return sessions.get(id)!;
  const database = await sessionDatabase();
  let session: LocalSession | undefined = database.read(id);
  if (!session) {
    // Older browser cookies retain their profile when its file is imported on first access.
    await database.importLegacy(database.directory);
    session = (database.read(id) as LocalSession | undefined) || emptySession();
  }
  let changed = false;
  for (const provider of providers) {
    if (!session.connections[provider] || !session.offers[provider]) {
      session.connections[provider] ||= emptySession().connections[provider];
      session.offers[provider] ||= [];
      changed = true;
    }
    const offers = session.offers[provider].filter(
      offer => offer.source === "live" || offer.source === "import",
    );
    if (offers.length !== session.offers[provider].length) {
      session.offers[provider] = offers;
      if (!offers.length) delete session.updatedAt[provider];
      changed = true;
    }
  }
  const legacy = session as LocalSession & { xiaochanHeaders?: unknown; waimaiToken?: unknown };
  for (const field of ["xiaochanHeaders", "waimaiToken"] as const) {
    if (Object.hasOwn(legacy, field)) {
      delete legacy[field];
      changed = true;
    }
  }
  for (const provider of ["xiaochan", "waimai"] as const) {
    const account = provider === "xiaochan" ? session.xiaochanAccount : session.waimaiAccount;
    if (!account && session.connections[provider].state !== "disconnected") {
      session.connections[provider] = { state: "disconnected", label: "未连接" };
      changed = true;
    }
  }
  if (changed) await saveSession(id, session);
  sessions.set(id, session);
  return session;
}

export async function saveSession(id: string, session: LocalSession) {
  (await sessionDatabase()).write(id, session);
  sessions.set(id, session);
}

export function withSessionLock<T>(
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  locks.set(id, current);
  void current
    .finally(() => {
      if (locks.get(id) === current) locks.delete(id);
    })
    .catch(() => {});
  return current;
}

export function samePlatformAccount(a: LocalSession, b: LocalSession, provider: Provider): boolean {
  const account = (session: LocalSession) => provider === "xiaochan" ? session.xiaochanAccount
    : provider === "waimai" ? session.waimaiAccount : session.meituanStorage;
  return JSON.stringify(account(a) ?? null) === JSON.stringify(account(b) ?? null);
}

export function publicSession(session: LocalSession): DashboardData {
  const enrollmentSchedules = [
    ...Object.values(session.xiaochanSchedules || {}),
    ...Object.values(session.waimaiSchedules || {}),
  ].map(({ offerId, name, runAt, state, message }) =>
    ({ offerId, name, runAt, state, ...(message ? { message } : {}) }),
  );
  return {
    location: session.location,
    connections: session.connections,
    offers: {
      ...session.offers,
      xiaochan: session.offers.xiaochan.map(offer => {
        const { enrollment: _storedEnrollment, enrollmentSchedule: _storedSchedule, ...activity } = offer;
        const enrollment = session.xiaochanEnrollments?.[offer.id];
        const enrollmentSchedule = enrollmentSchedules.find(schedule => schedule.offerId === offer.id);
        return { ...activity, ...(enrollmentSchedule ? { enrollmentSchedule } : {}), ...(enrollment ? { enrollment: {
          state: enrollment.state, orderId: enrollment.orderId,
        } } : {}) };
      }),
      waimai: session.offers.waimai.map(offer => {
        const { enrollment: _storedEnrollment, enrollmentSchedule: _storedSchedule, ...activity } = offer;
        const enrollment = session.waimaiEnrollments?.[offer.id];
        const enrollmentSchedule = enrollmentSchedules.find(schedule => schedule.offerId === offer.id);
        return { ...activity, ...(enrollmentSchedule ? { enrollmentSchedule } : {}), ...(enrollment ? { enrollment: {
          state: enrollment.state, orderId: enrollment.orderId,
        } } : {}) };
      }),
    },
    updatedAt: session.updatedAt,
    enrollmentSchedules,
  };
}
