<script setup lang="ts">
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Heart,
  Link2,
  LogOut,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Utensils,
  X,
} from "@lucide/vue";
import type { DashboardData, Provider, StoreMatch } from "#shared/types";
import { matchStores } from "#shared/utils/matching";
import { activeAt, calculatePrice, money } from "#shared/utils/pricing";
import { csvCell } from "#shared/utils/import";
import type PriceCalculator from "./components/PriceCalculator.vue";

type View = "matches" | "favorites" | "accounts" | "guide";
const view = ref<View>("matches"),
  loaded = ref(false);
const data = ref<DashboardData>({
  location: null,
  connections: {
    xiaochan: { state: "disconnected", label: "未连接" },
    meituan: { state: "disconnected", label: "未登录" },
  },
  offers: { xiaochan: [], meituan: [] },
  updatedAt: {},
});
const busy = ref(""),
  notice = ref<{ text: string; error: boolean } | null>(null);
const search = ref(""),
  filter = ref("all"),
  sort = ref("price"),
  onlyAvailable = ref(true),
  favorites = ref<string[]>([]);
const xiaochanSession = ref(""),
  importProvider = ref<Provider>("xiaochan"),
  importInput = ref<HTMLInputElement>();
const calculator = ref<InstanceType<typeof PriceCalculator>>(),
  locationDialog = ref<HTMLDialogElement>();
const locationForm = ref({
  label: "",
  cityCode: undefined as number | undefined,
  latitude: undefined as number | undefined,
  longitude: undefined as number | undefined,
});
const matches = computed(() =>
  matchStores(data.value.offers.xiaochan, data.value.offers.meituan),
);
const preview = (m: StoreMatch) =>
  calculatePrice({
    paidCents: Math.max(
      m.xiaochan.rule.thresholdCents,
      m.meituan.rule.thresholdCents,
    ),
    xiaochan: m.xiaochan,
    meituan: m.meituan,
  });
const visibleMatches = computed(() => {
  let rows = matches.value.filter(
    (m) =>
      !search.value ||
      `${m.xiaochan.name} ${m.meituan.name} ${m.xiaochan.category}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  );
  if (onlyAvailable.value)
    rows = rows.filter((m) => activeAt(m.xiaochan) && activeAt(m.meituan));
  if (view.value === "favorites")
    rows = rows.filter((m) => favorites.value.includes(m.id));
  if (filter.value === "low")
    rows = rows.filter((m) => preview(m).theoreticalNetCents <= 500);
  if (filter.value === "no-review")
    rows = rows.filter(
      (m) =>
        m.xiaochan.requirement.startsWith("无需评价") &&
        m.meituan.requirement.startsWith("无需评价"),
    );
  return rows.sort((a, b) =>
    sort.value === "distance"
      ? (a.xiaochan.distanceMeters ?? Infinity) -
        (b.xiaochan.distanceMeters ?? Infinity)
      : sort.value === "rebate"
        ? preview(b).totalRebateCents - preview(a).totalRebateCents
        : preview(a).theoreticalNetCents - preview(b).theoreticalNetCents,
  );
});
const lastUpdated = computed(() => {
  const dates = Object.values(data.value.updatedAt).filter(Boolean).sort();
  return dates.length
      ? `最近同步 ${new Date(dates.at(-1)!).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })}`
      : "尚未同步活动";
});
const titles: Record<View, string> = {
  matches: "同店叠加",
  favorites: "收藏",
  accounts: "账号管理",
  guide: "使用指南",
};
onMounted(async () => {
  try {
    favorites.value = JSON.parse(
      localStorage.getItem("food-favorites") || "[]",
    ).filter((v: unknown) => typeof v === "string" && !/^demo-x-\d+::demo-m-\d+$/.test(v));
    localStorage.setItem("food-favorites", JSON.stringify(favorites.value));
  } catch {
    favorites.value = [];
  }
  try {
    data.value = await $fetch<DashboardData>("/api/dashboard");
  } catch (error) {
    showError(error);
  }
  loaded.value = true;
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
async function sync() {
  if (!data.value.location) {
    openLocation();
    return;
  }
  if (data.value.connections.xiaochan.state === "disconnected" && data.value.connections.meituan.state !== "connected") {
    view.value = "accounts";
    notice.value = {
      text: "请先连接平台账号",
      error: false,
    };
    return;
  }
  await action("sync", async () => {
    const r = await post<{
      data: DashboardData;
      errors: string[];
      message: string;
    }>("/api/sync");
    data.value = r.data;
    notice.value = {
      text: r.errors.length
        ? r.errors.join("；")
        : r.message,
      error: r.errors.length > 0,
    };
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
async function loginMeituan() {
  await action("meituan-start", async () => {
    const r = await post<{ message: string }>("/api/connections/meituan/start");
    data.value = await $fetch<DashboardData>("/api/dashboard");
    notice.value = { text: r.message, error: false };
  });
}
async function verifyMeituan() {
  await action("meituan-verify", async () => {
    data.value = await post<DashboardData>("/api/connections/meituan/verify");
    notice.value = {
      text: "登录成功",
      error: false,
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
function toggleFavorite(id: string) {
  favorites.value = favorites.value.includes(id)
    ? favorites.value.filter((v) => v !== id)
    : [...favorites.value, id];
  localStorage.setItem("food-favorites", JSON.stringify(favorites.value));
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
      "小蚕返现(元)",
      "美团返现(元)",
      "到手价试算(元)",
      "数据来源",
      "小蚕采集时间",
      "美团采集时间",
      "叠加状态",
    ],
  ];
  for (const m of visibleMatches.value) {
    const p = preview(m);
    rows.push([
      m.xiaochan.name,
      m.confidence === "id" ? "已匹配" : "待核验",
      money(p.paidCents),
      money(p.xiaochanCents),
      money(p.meituanCents),
      money(p.theoreticalNetCents),
      `${sourceLabels[m.xiaochan.source]}/${sourceLabels[m.meituan.source]}`,
      m.xiaochan.collectedAt,
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
function downloadTemplate() {
  download(
    "[]\n",
    `${importProvider.value}-数据模板.json`,
    "application/json",
  );
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  await action("import", async () => {
    if (file.size > 1_000_000) throw new Error("JSON 文件不能超过 1MB");
    let rows;
    try {
      rows = JSON.parse(await file.text());
    } catch {
      throw new Error("文件不是有效 JSON，请参考模板");
    }
    data.value = await post<DashboardData>("/api/import", {
      provider: importProvider.value,
      offers: rows,
    });
    notice.value = {
      text: `已导入 ${data.value.offers[importProvider.value].length} 条活动`,
      error: false,
    };
  });
  input.value = "";
}
function changeView(next: View) {
  view.value = next;
  filter.value = "all";
  search.value = "";
}
function openLocation() {
  locationForm.value = data.value.location ? { ...data.value.location } : {
    label: "", cityCode: undefined, latitude: undefined, longitude: undefined,
  };
  locationDialog.value?.showModal();
}
async function saveLocation() {
  await action("location", async () => {
    data.value = await post<DashboardData>("/api/location", locationForm.value);
    locationDialog.value?.close();
    notice.value = {
      text: "地址已更新，请重新同步活动",
      error: false,
    };
  });
}
</script>

<template>
  <NuxtRouteAnnouncer />
  <div class="app-shell">
    <aside class="sidebar" aria-label="主导航">
      <button
        class="brand"
        aria-label="叠个饭首页"
        @click="changeView('matches')"
      >
        <span class="brand-mark"
          ><Utensils :size="24" :stroke-width="2.1" /></span
        ><span>叠个饭</span>
      </button>
      <nav class="main-nav">
        <button
          :class="{ active: view === 'matches' }"
          :aria-current="view === 'matches' ? 'page' : undefined"
          @click="changeView('matches')"
        >
          <Link2 :size="19" />同店叠加<ChevronRight
            class="nav-arrow"
            :size="16"
          /></button
        ><button
          :class="{ active: view === 'favorites' }"
          :aria-current="view === 'favorites' ? 'page' : undefined"
          @click="changeView('favorites')"
        >
          <Heart :size="19" />收藏<span
            v-if="favorites.length"
            class="nav-count"
            >{{ favorites.length }}</span
          ></button
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
    </aside>
    <div class="workspace">
      <header class="topbar">
        <span class="breadcrumb"
          >工作台 <ChevronRight :size="14" /><strong>{{
            titles[view]
          }}</strong></span
        >
        <div class="topbar-actions">
          <button class="location-button" @click="openLocation">
            <MapPin :size="16" /><span>{{
              data.location?.label || "设置收餐地址"
            }}</span
            ><ChevronDown :size="14" /></button
          ><span class="topbar-divider"></span
          ><button
            class="help-button"
            aria-label="查看使用指南"
            @click="changeView('guide')"
          >
            <CircleHelp :size="20" /></button
          >
        </div>
      </header>
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
        <template v-if="view === 'matches' || view === 'favorites'">
          <section class="page-heading">
            <div>
              <h1>
                {{
                  view === "favorites"
                    ? "收藏活动"
                    : "同店叠加"
                }}
              </h1>
            </div>
            <button
              class="button primary sync-button"
              :disabled="!!busy || !loaded"
              @click="sync"
            >
              <RefreshCw :size="16" :class="{ spinning: busy === 'sync' }" />{{
                busy === "sync" ? "正在同步…" : "同步活动"
              }}
            </button>
          </section>
          <section class="connection-bar" aria-label="平台连接状态">
            <div class="platform-connection">
              <span class="platform-logo xiaochan-logo">蚕</span>
              <div>
                <strong>小蚕霸王餐</strong
                ><span>{{ data.connections.xiaochan.label }}</span>
              </div>
              <button @click="changeView('accounts')">
                {{
                  data.connections.xiaochan.state === "disconnected"
                    ? "导入会话"
                    : "管理会话"
                }}<Plus :size="14" />
              </button>
            </div>
            <span class="connection-join"><Link2 :size="18" /></span>
            <div class="platform-connection">
              <span class="platform-logo meituan-logo">美</span>
              <div>
                <strong>美团试吃官</strong
                ><span>{{ data.connections.meituan.label }}</span>
              </div>
              <button @click="changeView('accounts')">
                {{
                  data.connections.meituan.state === "connected"
                    ? "管理账号"
                    : "登录"
                }}<Plus :size="14" />
              </button>
            </div>
          </section>
          <section class="results-section" aria-label="同店匹配结果">
            <div class="results-title">
              <h2>
                {{ view === "favorites" ? "收藏列表" : "匹配活动"
                }}<span>{{ visibleMatches.length }}</span>
              </h2>
              <div>
                <span class="updated-at">{{ lastUpdated }}</span
                ><button
                  class="text-button"
                  :disabled="!visibleMatches.length"
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
                  @click="filter = 'all'"
                >
                  全部</button
                ><button
                  :class="{ selected: filter === 'low' }"
                  @click="filter = 'low'"
                >
                  到手价 ≤ ¥5</button
                ><button
                  :class="{ selected: filter === 'no-review' }"
                  @click="filter = 'no-review'"
                >
                  双方无需评价
                </button>
              </div>
              <label class="search-box"
                ><Search :size="16" /><input
                  v-model="search"
                  type="search"
                  placeholder="搜索店铺、分店或品类"
                  aria-label="搜索店铺"
              /></label>
            </div>
            <div class="secondary-filters">
              <label class="availability"
                ><input v-model="onlyAvailable" type="checkbox" /><span
                  class="switch-track"
                ></span
                >仅看有效活动</label
              ><label class="sort-control"
                ><SlidersHorizontal :size="14" /><select
                  v-model="sort"
                  aria-label="结果排序"
                >
                  <option value="price">到手价升序</option>
                  <option value="rebate">返现降序</option>
                  <option value="distance">距离升序</option>
                </select></label
              >
            </div>
            <div v-if="visibleMatches.length" class="store-grid">
              <StoreCard
                v-for="match in visibleMatches"
                :key="match.id"
                :match="match"
                :saved="favorites.includes(match.id)"
                @favorite="toggleFavorite"
                @calculate="calculator?.open($event)"
              />
            </div>
            <div v-else class="empty-state">
              <span><Search :size="30" /></span>
              <h3>
                {{
                  view === "favorites"
                    ? "暂无收藏活动"
                    : matches.length
                      ? "暂无筛选结果"
                      : "暂无匹配活动"
                }}
              </h3>
              <button
                v-if="matches.length"
                class="button secondary"
                @click="
                  search = '';
                  filter = 'all';
                  onlyAvailable = false;
                "
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
              <ArrowLeft :size="16" />返回同店叠加
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
              <label for="xiaochan-session">本人登录会话</label
              ><textarea
                id="xiaochan-session"
                v-model="xiaochanSession"
                placeholder="gw.xiaocantech.com/rpc 请求的 cURL 或请求头 JSON"
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
                    : "打开登录窗口"
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
              <p class="field-help">
                需要 Google Chrome
              </p>
            </section>
          </div>
          <section class="import-section">
            <div>
              <h2>活动导入</h2>
            </div>
            <div class="import-actions">
              <select v-model="importProvider" aria-label="选择导入平台">
                <option value="xiaochan">小蚕霸王餐</option>
                <option value="meituan">美团试吃官</option></select
              ><button class="button secondary" @click="downloadTemplate">
                <ArrowDownToLine :size="15" />下载模板</button
              ><button
                class="button dark"
                :disabled="!!busy"
                @click="importInput?.click()"
              >
                <Plus :size="16" />{{
                  busy === "import" ? "导入中…" : "导入 JSON"
                }}</button
              ><input
                ref="importInput"
                class="visually-hidden"
                type="file"
                accept=".json,application/json"
                @change="importFile"
              />
            </div>
          </section>
          <div class="account-sync-footer">
            <span
              >小蚕 {{ data.offers.xiaochan.length }} 条 · 美团
              {{ data.offers.meituan.length }} 条</span
            ><button
              class="button primary"
              :disabled="!!busy || !loaded"
              @click="sync"
            >
              <RefreshCw :size="16" :class="{ spinning: busy === 'sync' }" />{{
                busy === "sync" ? "同步中…" : "同步活动"
              }}
            </button>
          </div>
        </template>
        <template v-else>
          <section class="page-heading">
            <div>
              <h1>使用指南</h1>
            </div>
          </section>
          <div class="guide-layout">
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
                <ShieldCheck :size="22" />
                <div>
                  <h3>美团试吃官</h3>
                  <p>在官方窗口完成短信登录后验证登录状态。</p>
                </div>
              </div>
              <div class="guide-entry">
                <SlidersHorizontal :size="22" />
                <div>
                  <h3>活动数据</h3>
                  <p>连接账号后同步，或按模板导入活动。</p>
                </div>
              </div>
              <h2 class="guide-subheading">优惠券限制</h2>
              <p>使用美团活动页优惠券的订单不参与试吃官返现。</p>
            </section>
            <aside class="guide-aside">
              <h3>相关入口</h3>
              <p>参考项目</p>
              <a
                href="https://github.com/lyrric/xiaochan"
                target="_blank"
                rel="noreferrer"
                >lyrric / xiaochan<ArrowRight :size="14"
              /></a>
              <button
                class="button primary full-width"
                @click="changeView('accounts')"
              >
                账号管理<ArrowRight :size="15" />
              </button>
            </aside>
          </div>
        </template>
      </main>
    </div>
  </div>
  <PriceCalculator ref="calculator" />
  <dialog
    ref="locationDialog"
    class="location-dialog"
    aria-label="收餐地址"
    @click="$event.target === locationDialog && locationDialog?.close()"
  >
    <form @submit.prevent="saveLocation">
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
      <label
        >地址名称<input
          v-model="locationForm.label"
          required
          maxlength="100"
          placeholder="收餐地址名称" /></label
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
