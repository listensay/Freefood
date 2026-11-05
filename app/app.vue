<script setup lang="ts">
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Link2,
  LogOut,
  MapPin,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "@lucide/vue";
import type {
  BawangcanProvider,
  DashboardData,
  Provider,
  StoreMatch,
} from "#shared/types";
import { providerShortNames } from "#shared/types";
import { MEITUAN_ACTIVITY_URL, MEITUAN_LOGIN_URL } from "#shared/meituan";
import { groupStoreMatches, matchStores } from "#shared/utils/matching";
import { estimatePrice, money, priceOutcome, suggestedPaidCents } from "#shared/utils/pricing";
import { csvCell } from "#shared/utils/import";
import { addressFromGeocode } from "#shared/utils/location";
import { COMPARISON_RADIUS_METERS, matchWithinRadius } from "#shared/utils/scope";
import type RemoteMeituanLogin from "./components/RemoteMeituanLogin.vue";

type View = "matches" | "accounts" | "guide";
const view = ref<View>("matches"),
  loaded = ref(false);
const data = ref<DashboardData>({
  location: null,
  connections: {
    xiaochan: { state: "disconnected", label: "未连接" },
    waimai: { state: "disconnected", label: "未连接" },
    meituan: { state: "disconnected", label: "未登录" },
  },
  offers: { xiaochan: [], waimai: [], meituan: [] },
  updatedAt: {},
});
const busy = ref(""),
  notice = ref<{ text: string; error: boolean } | null>(null);
const filter = ref("all"),
  sort = ref("price");
const xiaochanSession = ref(""),
  meituanSession = ref(""),
  waimaiToken = ref(""),
  bawangcanProvider = ref<BawangcanProvider>("xiaochan");
const meituanLogin = ref<InstanceType<typeof RemoteMeituanLogin>>(),
  meituanImport = ref<HTMLDetailsElement>(),
  locationDialog = ref<HTMLDialogElement>();
const locationForm = ref({
  label: "",
  cityName: "",
  cityCode: undefined as number | undefined,
  latitude: undefined as number | undefined,
  longitude: undefined as number | undefined,
});
const locationError = ref("");
const matches = computed(() =>
  matchStores(
    data.value.offers[bawangcanProvider.value],
    data.value.offers.meituan,
  ).filter(match =>
    matchWithinRadius(match, COMPARISON_RADIUS_METERS) &&
    (match.bawangcan.inventory ?? 0) > 0 &&
    (match.meituan.inventory ?? 0) > 0,
  ),
);
const preview = (m: StoreMatch) =>
  estimatePrice({
    paidCents: suggestedPaidCents(m.bawangcan),
    bawangcan: m.bawangcan,
    meituan: m.meituan,
  });
const visibleMatches = computed(() => {
  let rows = [...matches.value];
  if (filter.value === "low")
    rows = rows.filter((m) => preview(m).theoreticalNetCents <= 500);
  if (filter.value === "no-review")
    rows = rows.filter(
      (m) =>
        m.bawangcan.requirement.startsWith("无需评价") &&
        m.meituan.requirement.startsWith("无需评价") && !m.meituan.reviewBonus,
    );
  return rows.sort((a, b) =>
    sort.value === "distance"
      ? (a.bawangcan.distanceMeters ?? Infinity) -
        (b.bawangcan.distanceMeters ?? Infinity)
      : sort.value === "rebate"
        ? preview(b).totalRebateCents - preview(a).totalRebateCents
        : preview(a).theoreticalNetCents - preview(b).theoreticalNetCents,
  );
});
const visibleGroups = computed(() =>
  groupStoreMatches(visibleMatches.value),
);
const lastUpdated = computed(() => {
  const dates = [
    data.value.updatedAt[bawangcanProvider.value],
    data.value.updatedAt.meituan,
  ].filter(Boolean).sort();
  return dates.length
      ? `最近同步 ${new Date(dates.at(-1)!).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })}`
      : "尚未同步活动";
});
const sortOptions = [
  { value: "price", label: "支出升序" },
  { value: "rebate", label: "返现降序" },
  { value: "distance", label: "距离升序" },
];
let syncTimer: ReturnType<typeof setInterval> | undefined;
let mounted = false;
onMounted(async () => {
  mounted = true;
  try {
    const savedProvider = localStorage.getItem("food-bawangcan-provider");
    if (savedProvider === "xiaochan" || savedProvider === "waimai")
      bawangcanProvider.value = savedProvider;
  } catch {}
  try {
    data.value = await $fetch<DashboardData>("/api/dashboard");
    if (!data.value.location) await locateAddress();
  } catch (error) {
    showError(error);
  }
  loaded.value = true;
  if (mounted) {
    syncTimer = setInterval(() => { void sync(true); }, 5 * 60_000);
    void sync(true);
  }
});
onBeforeUnmount(() => {
  mounted = false;
  clearInterval(syncTimer);
});
function showError(error: any) {
  notice.value = {
    text:
      error.data?.statusMessage ||
      error.statusMessage ||
      error.message ||
      "操作失败，请重试",
    error: true,
  };
}
async function action(name: string, task: () => Promise<void>) {
  if (busy.value) return;
  busy.value = name;
  notice.value = null;
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    busy.value = "";
  }
}
const post = <T,>(url: string, body?: Record<string, unknown>) =>
  $fetch<T>(url, { method: "POST", body, headers: { "x-food-request": "1" } });
async function sync(automatic = false) {
  if (busy.value || !loaded.value) return;
  if (automatic && (
    !data.value.location ||
    (data.value.connections[bawangcanProvider.value].state !== "configured" &&
      !["connected", "configured"].includes(data.value.connections.meituan.state)) ||
    (bawangcanProvider.value === "waimai" &&
      data.value.connections.waimai.state === "configured" && !data.value.location.cityName)
  )) return;
  if (!data.value.location) {
    if (!(await locateAddress())) {
      openLocation();
      return;
    }
  }
  if (
    data.value.connections[bawangcanProvider.value].state !== "configured" &&
    !["connected", "configured"].includes(data.value.connections.meituan.state)
  ) {
    view.value = "accounts";
    notice.value = {
      text: "请先连接平台账号",
      error: false,
    };
    return;
  }
  if (
    bawangcanProvider.value === "waimai" &&
    data.value.connections.waimai.state === "configured" &&
    !data.value.location?.cityName
  ) {
    openLocation();
    return;
  }
  await action("sync", async () => {
    try {
      const r = await post<{
        data: DashboardData;
        errors: string[];
        message: string;
      }>("/api/sync", { provider: bawangcanProvider.value });
      data.value = r.data;
      if (r.errors.length || !automatic) notice.value = {
        text: r.errors.length ? r.errors.join("；") : r.message,
        error: r.errors.length > 0,
      };
    } catch (error: any) {
      if (!automatic || error.statusCode !== 429) throw error;
    }
  });
}
async function connectXiaochan() {
  await action("xiaochan", async () => {
    data.value = await post<DashboardData>("/api/connections/xiaochan", {
      session: xiaochanSession.value,
    });
    xiaochanSession.value = "";
    notice.value = {
      text: "会话已保存",
      error: false,
    };
  });
}
async function connectWaimai(guest = false) {
  await action("waimai", async () => {
    data.value = await post<DashboardData>("/api/connections/waimai", {
      token: guest ? "" : waimaiToken.value,
    });
    waimaiToken.value = "";
    notice.value = {
      text: guest ? "访客访问已启用" : "会话已保存",
      error: false,
    };
  });
}
async function loginMeituan() {
  await action("meituan-start", async () => {
    await meituanLogin.value?.open();
    data.value = await $fetch<DashboardData>("/api/dashboard");
  });
}
async function importMeituanSession() {
  await action("meituan-session", async () => {
    data.value = await post<DashboardData>("/api/connections/meituan/session", {
      session: meituanSession.value,
    });
    meituanSession.value = "";
    notice.value = { text: "会话已保存，请验证登录", error: false };
  });
}
async function openMeituanImport() {
  view.value = "accounts";
  await nextTick();
  if (meituanImport.value) meituanImport.value.open = true;
}
function connectedMeituan(result: DashboardData) {
  data.value = result;
  notice.value = { text: result.connections.meituan.message || "登录成功", error: result.connections.meituan.state !== "connected" };
}
async function verifyMeituan() {
  await action("meituan-verify", async () => {
    data.value = await post<DashboardData>("/api/connections/meituan/verify");
    notice.value = {
      text: data.value.connections.meituan.message || "登录成功",
      error: data.value.connections.meituan.state !== "connected",
    };
  });
}
async function disconnect(provider: Provider) {
  await action(`disconnect-${provider}`, async () => {
    data.value = await $fetch<DashboardData>(`/api/connections/${provider}`, {
      method: "DELETE",
      headers: { "x-food-request": "1" },
    });
    notice.value = {
      text: "连接已断开",
      error: false,
    };
  });
}
function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportResults() {
  const sourceLabels = { live: "同步", import: "导入" };
  const rows = [
    [
      "店铺",
      "分店状态",
      "实付试算(元)",
      `${providerShortNames[bawangcanProvider.value]}返现(元)`,
      "美团返现(元)",
      "收支试算(元)",
      "收支结果",
      "数据来源",
      `${providerShortNames[bawangcanProvider.value]}采集时间`,
      "美团采集时间",
      "叠加状态",
    ],
  ];
  for (const m of visibleGroups.value.flatMap(group => group.matches)) {
    const p = preview(m);
    rows.push([
      m.bawangcan.name,
      m.confidence === "id" ? "已匹配" : "待核验",
      money(p.paidCents),
      money(p.bawangcanCents),
      money(p.meituanCents),
      money(p.balanceCents),
      priceOutcome(p.balanceCents).label,
      `${sourceLabels[m.bawangcan.source]}/${sourceLabels[m.meituan.source]}`,
      m.bawangcan.collectedAt,
      m.meituan.collectedAt,
      "待确认",
    ]);
  }
  download(
    "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n"),
    "叠个饭-同店试算.csv",
    "text/csv;charset=utf-8",
  );
}
function changeView(next: View) {
  view.value = next;
  filter.value = "all";
}
function changeCombination(provider: BawangcanProvider) {
  bawangcanProvider.value = provider;
  try {
    localStorage.setItem("food-bawangcan-provider", provider);
  } catch {}
  filter.value = "all";
}
function openLocation() {
  locationError.value = "";
  locationForm.value = data.value.location ? { ...data.value.location, cityName: data.value.location.cityName || "" } : {
    label: "", cityName: "", cityCode: undefined, latitude: undefined, longitude: undefined,
  };
  locationDialog.value?.showModal();
  if (locationDialog.value) locationDialog.value.scrollTop = 0;
}
async function locateAddress() {
  locationError.value = "";
  let located = false;
  await action("locate", async () => {
    if (!window.isSecureContext || !navigator.geolocation)
      throw new Error("当前连接不支持定位，请手动填写地址");
    const position = await new Promise<GeolocationPosition>(
      (resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          resolve,
          (error) => {
            reject(
              new Error(
                error.code === 1
                  ? "定位权限未开启，请允许定位或手动填写地址"
                  : "定位失败，请重试或手动填写地址",
              ),
            );
          },
          { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
        );
      },
    );
    const { latitude, longitude } = position.coords;
    const url = new URL(
      "https://api.bigdatacloud.net/data/reverse-geocode-client",
    );
    url.search = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      localityLanguage: "zh",
    }).toString();
    let address;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("geocoding failed");
      address = addressFromGeocode(await response.json(), latitude, longitude);
    } catch {
      throw new Error("地址识别失败，请重试或手动填写");
    }
    data.value = await post<DashboardData>("/api/location", { ...address, automatic: true });
    locationForm.value = { ...address, cityName: address.cityName || "" };
    locationDialog.value?.close();
    notice.value = { text: "地址已定位", error: false };
    located = true;
  });
  if (!located && notice.value?.error && locationDialog.value?.open) {
    locationError.value = notice.value.text;
    notice.value = null;
  }
  return located;
}

async function saveLocation() {
  locationError.value = "";
  const form = locationDialog.value?.querySelector("form");
  const invalid = form?.querySelector<HTMLInputElement>("input:invalid");
  if (invalid) {
    locationError.value = invalid.validity.valueMissing
      ? "请填写完整地址"
      : "请检查城市代码与经纬度";
    invalid.setAttribute("aria-invalid", "true");
    invalid.focus();
    return;
  }
  await action("location", async () => {
    data.value = await post<DashboardData>("/api/location", locationForm.value);
    locationDialog.value?.close();
    notice.value = {
      text: "地址已更新，请重新同步活动",
      error: false,
    };
  });
  if (notice.value?.error && locationDialog.value?.open) {
    locationError.value = notice.value.text;
    notice.value = null;
  }
}
</script>

<template>
  <NuxtRouteAnnouncer />
  <div class="app-shell">
    <header class="site-header">
      <div class="header-inner">
        <button
          class="brand"
          aria-label="叠个饭首页"
          @click="changeView('matches')"
        >
          <img class="brand-mark" src="/icon-512.png" width="42" height="42" alt="" />
          <span>叠个饭</span>
        </button>
        <nav class="main-nav" aria-label="主导航">
          <button
            :class="{ active: view === 'matches' }"
            :aria-current="view === 'matches' ? 'page' : undefined"
            @click="changeView('matches')"
          >
            <Link2 :size="20" />首页</button
          ><button
            :class="{ active: view === 'accounts' }"
            :aria-current="view === 'accounts' ? 'page' : undefined"
            @click="changeView('accounts')"
          >
            <Settings2 :size="19" />账号管理</button
          ><button
            :class="{ active: view === 'guide' }"
            :aria-current="view === 'guide' ? 'page' : undefined"
            @click="changeView('guide')"
          >
            <BookOpen :size="19" />使用指南
          </button>
        </nav>
        <div class="topbar-actions">
          <button class="location-button" :disabled="busy === 'locate'" @click="openLocation">
            <MapPin :size="16" /><span>{{
              busy === "locate" ? "定位中…" : data.location?.label || "设置收餐地址"
            }}</span
            ><ChevronDown :size="14" /></button
          >
        </div>
      </div>
    </header>
    <div class="workspace">
      <main class="main-content">
        <div
          v-if="notice"
          class="notice"
          :class="{ 'notice-error': notice.error }"
          :role="notice.error ? 'alert' : 'status'"
        >
          <CircleHelp v-if="notice.error" :size="18" /><Check
            v-else
            :size="18"
          /><span>{{ notice.text }}</span
          ><button aria-label="关闭提示" @click="notice = null">
            <X :size="16" />
          </button>
        </div>
        <template v-if="view === 'matches'">
          <section class="page-heading">
            <button
              class="button primary sync-button"
              :disabled="!!busy || !loaded"
              @click="sync()"
            >
              <RefreshCw :size="16" :class="{ spinning: busy === 'sync' }" />{{
                busy === "sync" ? "正在同步…" : "同步活动"
              }}
            </button>
          </section>
          <div class="combination-tabs filter-tabs" aria-label="选择叠加组合">
            <button
              :class="{ selected: bawangcanProvider === 'xiaochan' }"
              :aria-pressed="bawangcanProvider === 'xiaochan'"
              @click="changeCombination('xiaochan')"
            ><span class="platform-logo xiaochan-logo" aria-hidden="true">蚕</span>小蚕</button>
            <button
              :class="{ selected: bawangcanProvider === 'waimai' }"
              :aria-pressed="bawangcanProvider === 'waimai'"
              @click="changeCombination('waimai')"
            ><span class="platform-logo waimai-logo" aria-hidden="true">歪</span>歪麦</button>
          </div>
          <section class="results-section" aria-label="同店匹配结果">
            <div class="results-title">
              <h2>
                7 公里内匹配活动<span>{{ visibleGroups.length }}</span>
              </h2>
              <div>
                <span class="updated-at">{{ lastUpdated }}</span
                ><button
                  class="text-button"
                  :disabled="!visibleGroups.length"
                  @click="exportResults"
                >
                  <ArrowDownToLine :size="15" />导出结果
                </button>
              </div>
            </div>
            <div class="filter-toolbar">
              <div class="filter-tabs" aria-label="筛选活动">
                <button
                  :class="{ selected: filter === 'all' }"
                  :aria-pressed="filter === 'all'"
                  @click="filter = 'all'"
                >
                  全部</button
                ><button
                  :class="{ selected: filter === 'low' }"
                  :aria-pressed="filter === 'low'"
                  @click="filter = 'low'"
                >
                  支出 ≤ ¥5</button
                ><button
                  :class="{ selected: filter === 'no-review' }"
                  :aria-pressed="filter === 'no-review'"
                  @click="filter = 'no-review'"
                >
                  双方无需评价
                </button>
              </div>
              <div class="secondary-filters">
                <div class="sort-control">
                  <SlidersHorizontal :size="16" />
                  <UiSelect
                    v-model="sort"
                    :options="sortOptions"
                    label="结果排序"
                  />
                </div>
              </div>
            </div>
            <StoreGrid v-if="visibleGroups.length">
              <StoreCard
                v-for="group in visibleGroups"
                :key="group.id"
                :group="group"
              />
            </StoreGrid>
            <div v-else class="empty-state">
              <span><Search :size="30" /></span>
              <h3>
                {{
                  matches.length ? "暂无筛选结果" : "暂无匹配活动"
                }}
              </h3>
              <button
                v-if="matches.length"
                class="button secondary"
                @click="filter = 'all'"
              >
                清除筛选</button
              ><button
                v-else
                class="button primary"
                @click="changeView('accounts')"
              >
                账号管理<ArrowRight :size="15" />
              </button>
            </div>
          </section>
        </template>
        <template v-else-if="view === 'accounts'">
          <section class="page-heading">
            <div>
              <h1>账号管理</h1>
            </div>
            <button class="button secondary" @click="changeView('matches')">
              <ArrowLeft :size="16" />返回首页
            </button>
          </section>
          <div class="account-grid">
            <section class="account-panel">
              <header>
                <span class="platform-logo xiaochan-logo">蚕</span>
                <div>
                  <h2>小蚕霸王餐</h2>
                  <span>{{ data.connections.xiaochan.label }}</span>
                </div>
                <button
                  v-if="data.connections.xiaochan.state !== 'disconnected'"
                  class="text-button"
                  :disabled="!!busy"
                  @click="disconnect('xiaochan')"
                >
                  <LogOut :size="14" />断开
                </button>
              </header>
              <h3>小程序会话导入</h3>
              <label for="xiaochan-session">小程序请求会话</label
              ><textarea
                id="xiaochan-session"
                v-model="xiaochanSession"
                placeholder="粘贴小蚕请求头、请求头 JSON 或 cURL"
                rows="6"
                autocomplete="off"
                spellcheck="false"
              ></textarea>
              <button
                class="button primary full-width"
                :disabled="!!busy || !xiaochanSession.trim()"
                @click="connectXiaochan"
              >
                <Link2 :size="16" />{{
                  busy === "xiaochan" ? "保存中…" : "保存会话"
                }}
              </button>
            </section>
            <section class="account-panel">
              <header>
                <span class="platform-logo waimai-logo">歪</span>
                <div>
                  <h2>歪麦霸王餐</h2>
                  <span>{{ data.connections.waimai.label }}</span>
                </div>
                <button
                  v-if="data.connections.waimai.state !== 'disconnected'"
                  class="text-button"
                  :disabled="!!busy"
                  @click="disconnect('waimai')"
                >
                  <LogOut :size="14" />断开
                </button>
              </header>
              <h3>小程序会话导入</h3>
              <label for="waimai-token">登录 token（选填）</label>
              <textarea
                id="waimai-token"
                v-model="waimaiToken"
                placeholder="token 或请求头 JSON"
                rows="6"
                autocomplete="off"
                spellcheck="false"
              ></textarea>
              <button
                class="button primary full-width"
                :disabled="!!busy || !waimaiToken.trim()"
                @click="connectWaimai()"
              >
                <Link2 :size="16" />{{ busy === 'waimai' ? '保存中…' : '保存会话' }}
              </button>
              <button
                class="button secondary full-width verify-button"
                :disabled="!!busy"
                @click="connectWaimai(true)"
              >
                启用访客访问
              </button>
            </section>
            <section class="account-panel">
              <header>
                <span class="platform-logo meituan-logo">美</span>
                <div>
                  <h2>美团试吃官</h2>
                  <span>{{ data.connections.meituan.label }}</span>
                </div>
                <button
                  v-if="data.connections.meituan.state !== 'disconnected'"
                  class="text-button"
                  :disabled="!!busy"
                  @click="disconnect('meituan')"
                >
                  <LogOut :size="14" />断开
                </button>
              </header>
              <h3>官方短信登录</h3>
              <button
                class="button primary full-width"
                :disabled="!!busy"
                @click="loginMeituan"
              >
                <ArrowRight :size="16" />{{
                  busy === "meituan-start"
                    ? "打开中…"
                    : "打开登录页面"
                }}</button
              ><button
                class="button secondary full-width verify-button"
                :disabled="!!busy"
                @click="verifyMeituan"
              >
                <ShieldCheck :size="16" />{{
                  busy === "meituan-verify"
                    ? "验证中…"
                    : "验证登录"
                }}
              </button>
              <a
                class="button secondary full-width verify-button"
                :href="MEITUAN_LOGIN_URL"
                target="_blank"
                rel="noopener noreferrer"
                @click="openMeituanImport"
              >
                <ArrowRight :size="16" />浏览器登录
              </a>
              <details ref="meituanImport" class="meituan-session-import">
                <summary>会话导入<ChevronDown :size="16" aria-hidden="true" /></summary>
                <a
                  class="text-button"
                  :href="MEITUAN_ACTIVITY_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                >试吃官页面<ArrowRight :size="14" /></a>
                <label for="meituan-session">本人登录会话</label>
                <textarea
                  id="meituan-session"
                  v-model="meituanSession"
                  rows="4"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="试吃官请求的 cURL、Cookie 或请求头 JSON"
                ></textarea>
                <button
                  class="button primary full-width"
                  :disabled="!!busy || !meituanSession.trim()"
                  @click="importMeituanSession"
                >
                  <Link2 :size="16" />{{ busy === 'meituan-session' ? '保存中…' : '保存会话' }}
                </button>
              </details>
            </section>
          </div>
        </template>
        <template v-else>
          <section class="page-heading">
            <div>
              <h1>使用指南</h1>
            </div>
          </section>
          <section class="guide-main">
            <h2>账号连接</h2>
            <div class="guide-entry">
              <Link2 :size="22" />
              <div>
                <h3>小蚕霸王餐</h3>
                <p>微信小程序登录后，导入本人请求会话。</p>
              </div>
            </div>
            <div class="guide-entry">
              <Link2 :size="22" />
              <div>
                <h3>歪麦霸王餐</h3>
                <p>导入本人小程序登录 token，或启用访客访问。</p>
              </div>
            </div>
            <div class="guide-entry">
              <ShieldCheck :size="22" />
              <div>
                <h3>美团试吃官</h3>
                <p>在登录页面完成短信登录后验证登录状态。</p>
              </div>
            </div>
            <div class="guide-entry">
              <SlidersHorizontal :size="22" />
              <div>
                <h3>活动数据</h3>
                <p>连接账号后，在首页同步活动。</p>
              </div>
            </div>
          </section>
        </template>
      </main>
    </div>
  </div>
  <RemoteMeituanLogin ref="meituanLogin" @connected="connectedMeituan" @updated="data = $event" @import-requested="openMeituanImport" />
  <dialog
    ref="locationDialog"
    class="location-dialog"
    aria-label="收餐地址"
    @click="$event.target === locationDialog && locationDialog?.close()"
  >
    <form novalidate @submit.prevent="saveLocation" @input="($event.target as HTMLInputElement).removeAttribute('aria-invalid'); locationError = ''">
      <header class="dialog-header">
        <h2>更换收餐地址</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭地址设置"
          @click="locationDialog?.close()"
        >
          <X :size="21" />
        </button>
      </header>
      <button
        type="button"
        class="button secondary full-width"
        :disabled="!!busy"
        @click="locateAddress"
      >
        <MapPin :size="16" />{{ busy === "locate" ? "定位中…" : "使用当前位置" }}
      </button>
      <p v-if="locationError" class="inline-error" role="alert">{{ locationError }}</p>
      <label
        >地址名称<input
          v-model="locationForm.label"
          required
          maxlength="100"
          placeholder="收餐地址名称" /></label
      ><label
        >城市名称<input
          v-model="locationForm.cityName"
          maxlength="50"
          :required="bawangcanProvider === 'waimai'"
          placeholder="例如：上海市" /></label
      ><label
        >城市代码<input
          v-model.number="locationForm.cityCode"
          type="number"
          required
          min="100000"
          max="999999"
          placeholder="六位城市代码"
      /></label>
      <div class="coordinate-fields">
        <label
          >纬度（GCJ-02）<input
            v-model.number="locationForm.latitude"
            type="number"
            step="any"
            required
            min="-90"
            max="90" /></label
        ><label
          >经度（GCJ-02）<input
            v-model.number="locationForm.longitude"
            type="number"
            step="any"
            required
            min="-180"
            max="180"
        /></label>
      </div>
      <button class="button primary full-width" :disabled="!!busy">
        {{ busy === "location" ? "保存中…" : "保存地址" }}
      </button>
    </form>
  </dialog>
</template>
