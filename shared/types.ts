export type Provider = "xiaochan" | "waimai" | "meituan";
export type BawangcanProvider = Exclude<Provider, "meituan">;
export const providers = ["xiaochan", "waimai", "meituan"] as const;
export const providerNames: Record<Provider, string> = {
  xiaochan: "小蚕霸王餐",
  waimai: "歪麦霸王餐",
  meituan: "美团试吃官",
};
export const providerShortNames: Record<Provider, string> = {
  xiaochan: "小蚕",
  waimai: "歪麦",
  meituan: "美团",
};
export type RebateRule =
  | { kind: "fixed"; thresholdCents: number; cashbackCents: number }
  | {
      kind: "percentage";
      thresholdCents: number;
      ratioBps: number;
      capCents: number;
    };

export interface ReviewBonus {
  ratioBps: number;
  capCents: number;
}

export interface SyncScope {
  radiusMeters: number;
}

export interface EnrollmentSchedule {
  offerId: string;
  name: string;
  runAt: string;
  state: "scheduled" | "running" | "failed";
  message?: string;
}

export interface Offer {
  id: string;
  provider: Provider;
  name: string;
  category: string;
  address?: string;
  image?: string;
  meituanPoiId?: string;
  opaquePoiId?: string;
  distanceMeters?: number;
  inventory?: number;
  startTime?: string;
  endTime?: string;
  validFrom?: string;
  validUntil?: string;
  requirement: string;
  rule: RebateRule;
  reviewBonus?: ReviewBonus;
  product?: { name: string; priceCents?: number };
  url?: string;
  collectedAt: string;
  source: "live" | "import";
  enrollment?: { state: "enrolled" | "unknown" | "cancel-unknown"; orderId?: string };
  enrollmentSchedule?: EnrollmentSchedule;
}

export interface StoreMatch {
  id: string;
  bawangcan: Offer;
  meituan: Offer;
  confidence: "id" | "name" | "candidate";
  reason: string;
}

export interface StoreMatchGroup {
  id: string;
  matches: StoreMatch[];
}

export interface LocationSettings {
  label: string;
  cityCode: number;
  cityName?: string;
  latitude: number;
  longitude: number;
}

export interface AccountProfile {
  userId: string;
  nickname?: string;
  avatar?: string;
  phone?: string;
}

export interface ConnectionStatus {
  state: "disconnected" | "configured" | "connected" | "expired" | "pending";
  label: string;
  updatedAt?: string;
  message?: string;
  profile?: AccountProfile;
}

export interface DashboardData {
  location: LocationSettings | null;
  connections: Record<Provider, ConnectionStatus>;
  offers: Record<Provider, Offer[]>;
  updatedAt: Partial<Record<Provider, string>>;
  enrollmentSchedules?: EnrollmentSchedule[];
}

export interface RemoteLoginSession {
  token: string;
  viewport: { width: number; height: number };
  expiresAt: string;
}

export type RemoteBrowserAction =
  | { type: "pointer"; phase: "down" | "move" | "up"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "wheel"; deltaX: number; deltaY: number }
  | { type: "reload" };
