export type Provider = "xiaochan" | "meituan";
export type RebateRule =
  | { kind: "fixed"; thresholdCents: number; cashbackCents: number }
  | {
      kind: "percentage";
      thresholdCents: number;
      ratioBps: number;
      capCents: number;
    };

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
  requirement: string;
  rule: RebateRule;
  url?: string;
  collectedAt: string;
  source: "live" | "import";
}

export interface StoreMatch {
  id: string;
  xiaochan: Offer;
  meituan: Offer;
  confidence: "id" | "name" | "candidate";
  reason: string;
}

export interface LocationSettings {
  label: string;
  cityCode: number;
  latitude: number;
  longitude: number;
}

export interface ConnectionStatus {
  state: "disconnected" | "configured" | "connected" | "expired" | "pending";
  label: string;
  updatedAt?: string;
  message?: string;
}

export interface DashboardData {
  location: LocationSettings | null;
  connections: Record<Provider, ConnectionStatus>;
  offers: Record<Provider, Offer[]>;
  updatedAt: Partial<Record<Provider, string>>;
}
