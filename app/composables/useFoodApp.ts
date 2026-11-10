import { ref, computed, watch, onMounted, onBeforeUnmount, provide, inject } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiFetch as $fetch } from "../lib/api";
import type { InjectionKey } from "vue";
import type { BawangcanProvider, DashboardData, EnrollmentTimeWindow, Provider, Offer, XiaochanScheduleOptions } from "#shared/types";
import { providerShortNames } from "#shared/types";
import { addressFromGeocode } from "#shared/utils/location";
import { defaultScheduleTime, scheduleTimeWindows, xiaochanAdvanceWindow } from "#shared/utils/xiaochan-advance-time";
import { nextAutomaticSyncCheck } from "#shared/utils/sync-time";

const foodAppKey: InjectionKey<ReturnType<typeof createFoodApp>> = Symbol("food-app");

function enrollmentProvider(offerId: string): BawangcanProvider | undefined {
  if (/^xiaochan:[1-9]\d*$/.test(offerId)) return "xiaochan";
  if (/^waimai:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/.test(offerId)) return "waimai";
}

function createFoodApp() {
  const loaded = ref(false);
  const route = useRoute();
  const router = useRouter();
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
  const actionBusy = ref("");
  const enrollingOfferIds = ref(new Set<string>());
  const enrollmentActions = ref<Record<string, string>>({});
  const now = ref(new Date());
  const scheduleDialog = ref<HTMLDialogElement>();
  const scheduleOffer = ref<Offer | null>(null);
  const scheduleTime = ref("");
  const scheduleError = ref("");
  const scheduleLoading = ref(false);
  const scheduleOptionsError = ref("");
  const scheduleAdvanceWindows = ref<EnrollmentTimeWindow[]>([]);
  const scheduleUseAdvance = ref(false);
  const scheduleCouponWindows = computed(() => {
    const offer = scheduleOffer.value;
    const potential = offer && xiaochanAdvanceWindow(offer, now.value);
    if (!offer || !potential) return [];
    return scheduleTimeWindows(offer, now.value, scheduleAdvanceWindows.value).flatMap(window => {
      const start = Math.max(window.start, potential.start), end = Math.min(window.end, potential.end);
      return Math.ceil(start / 1000) * 1000 < end ? [{ start, end }] : [];
    });
  });
  const scheduleAdvanceAvailable = computed(() => scheduleCouponWindows.value.length > 0);
  const scheduleWindows = computed(() => scheduleOffer.value
    ? scheduleUseAdvance.value ? scheduleCouponWindows.value : scheduleTimeWindows(scheduleOffer.value, now.value) : []);
  watch(scheduleAdvanceAvailable, available => {
    if (!available && scheduleUseAdvance.value) setScheduleUseAdvance(false);
  });
  const scheduleUsesAdvance = computed(() => {
    const potential = scheduleOffer.value && xiaochanAdvanceWindow(scheduleOffer.value, now.value);
    const selected = Date.parse(`${scheduleTime.value}+08:00`);
    return !!potential && selected < potential.end && scheduleWindows.value.some(window => selected >= window.start && selected < window.end);
  });
  const busy = computed(() => actionBusy.value || (enrollingOfferIds.value.size ? "enroll" : ""));
  const syncing = ref(false),
    notice = ref<{ text: string; error: boolean; source?: "sync" } | null>(null);
  const filter = ref("all"),
    sort = ref("price");
  const requiresCityName = computed(() => data.value.connections.waimai.state === "connected");
  const canSync = computed(() =>
    data.value.connections.xiaochan.state === "connected" || requiresCityName.value ||
    ["connected", "configured"].includes(data.value.connections.meituan.state),
  );
  const locationDialog = ref<HTMLDialogElement>();
  const locationForm = ref({
    label: "",
    cityName: "",
    cityCode: undefined as number | undefined,
    latitude: undefined as number | undefined,
    longitude: undefined as number | undefined,
  });
  const locationError = ref("");
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingScheduledSync = false;
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;
  let refreshingSchedules = false;
  let mounted = false;
  let dataRevision = 0;
  let scheduleRevision = 0;
  let scheduleOptionsRequest = 0;
  const refreshingProfiles = new Set<BawangcanProvider>();
  function runScheduledSync() {
    if (!mounted || route.path !== "/") return;
    if (busy.value || syncing.value) { pendingScheduledSync = true; return; }
    pendingScheduledSync = false;
    void sync(true);
  }
  function scheduleAutomaticSync() {
    const current = Date.now();
    syncTimer = setTimeout(() => {
      if (!mounted) return;
      scheduleAutomaticSync();
      runScheduledSync();
    }, nextAutomaticSyncCheck(current) - current);
  }
  watch([busy, syncing], () => {
    if (pendingScheduledSync && !busy.value && !syncing.value) runScheduledSync();
  });
  watch(() => route.path, () => {
    filter.value = "all";
    if (route.path !== "/") pendingScheduledSync = false;
    if (!mounted || !loaded.value) return;
    if (route.path === "/accounts") void refreshProfiles();
  });
  onMounted(async () => {
    mounted = true;
    try {
      data.value = await $fetch<DashboardData>("/api/dashboard", { timeout: 10_000 });
    } catch (error) {
      showError(error);
    }
    loaded.value = true;
    if (mounted) {
      void refreshProfiles();
      scheduleAutomaticSync();
      scheduleTimer = setInterval(() => { now.value = new Date(); void refreshSchedules(); }, 1000);
      if (route.path === "/" && !data.value.location) await locateAddress();
      void sync(true);
    }
  });
  onBeforeUnmount(() => {
    mounted = false;
    scheduleOptionsRequest++;
    clearTimeout(syncTimer);
    pendingScheduledSync = false;
    clearInterval(scheduleTimer);
  });
  function showError(error: any, source?: "sync") {
    notice.value = {
      text:
        error.data?.statusMessage ||
        error.statusMessage ||
        error.message ||
        "操作失败，请重试",
      error: true,
      ...(source ? { source } : {}),
    };
  }
  async function action(name: string, task: () => Promise<void>) {
    if (busy.value) return;
    dataRevision++;
    scheduleAdvanceWindows.value = [];
    actionBusy.value = name;
    notice.value = null;
    try {
      await task();
    } catch (error) {
      showError(error);
    } finally {
      actionBusy.value = "";
    }
  }
  const post = <T,>(url: string, body?: Record<string, unknown>) =>
    $fetch<T>(url, { method: "POST", body, headers: { "x-food-request": "1" } });
  async function refreshProfiles() {
    await Promise.all((["xiaochan", "waimai"] as const).map(async provider => {
      if (data.value.connections[provider].state !== "connected" ||
        data.value.connections[provider].profile || refreshingProfiles.has(provider)) return;
      refreshingProfiles.add(provider);
      const revision = dataRevision;
      try {
        const result = await post<DashboardData>(`/api/connections/${provider}/profile`);
        if (mounted && revision === dataRevision)
          data.value.connections[provider] = result.connections[provider];
      } catch (error: any) {
        if (error.statusCode === 401) {
          try {
            const result = await $fetch<DashboardData>("/api/dashboard");
            if (mounted && revision === dataRevision)
              data.value.connections[provider] = result.connections[provider];
          } catch {}
        }
        if (mounted && revision === dataRevision) showError(error);
      } finally {
        refreshingProfiles.delete(provider);
      }
    }));
  }
  async function sync(automatic = false) {
    if (busy.value || syncing.value || !loaded.value || (automatic && route.path !== "/")) return;
    if (automatic && (
      !data.value.location ||
      !canSync.value ||
      (requiresCityName.value && !data.value.location.cityName)
    )) return;
    if (!data.value.location) {
      if (!(await locateAddress())) {
        openLocation();
        return;
      }
    }
    if (!canSync.value) {
      await router.push("/accounts");
      notice.value = {
        text: "请先连接平台账号",
        error: false,
      };
      return;
    }
    if (
      requiresCityName.value &&
      !data.value.location?.cityName
    ) {
      openLocation();
      return;
    }
    syncing.value = true;
    const revision = dataRevision;
    let polling = false, pollActive = true;
    const pollTimer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const latest = await $fetch<DashboardData>("/api/dashboard", { timeout: 10_000 });
        if (pollActive && mounted && revision === dataRevision) data.value = latest;
      } catch {} finally { polling = false; }
    }, 2000);
    if (!automatic) notice.value = null;
    try {
        const r = await post<{
          data: DashboardData;
          errors: string[];
          message: string;
        }>("/api/sync", { automatic });
        if (!mounted || revision !== dataRevision) return;
        data.value = r.data;
        if ((r.errors.length || !automatic) && route.path === "/") notice.value = {
          text: r.errors.length ? r.errors.join("；") : r.message,
          error: r.errors.length > 0,
          source: "sync",
        };
        else if (automatic && route.path === "/" && notice.value?.source === "sync") notice.value = null;
    } catch (error: any) {
      if (mounted && revision === dataRevision && route.path === "/" &&
        (!automatic || error.statusCode !== 429)) showError(error, "sync");
    } finally {
      pollActive = false;
      clearInterval(pollTimer);
      syncing.value = false;
    }
  }
  async function connectComputerWeChat(provider: BawangcanProvider) {
    await action(`${provider}-wechat`, async () => {
      data.value = await post<DashboardData>(`/api/connections/${provider}/wechat`);
      notice.value = { text: "登录成功", error: false };
    });
  }
  function applyEnrollment(result: DashboardData, offerId: string) {
    const provider = enrollmentProvider(offerId);
    if (!provider) return;
    const enrollment = result.offers[provider].find(row => row.id === offerId)?.enrollment;
    const schedule = result.enrollmentSchedules?.find(row => row.offerId === offerId);
    for (const row of data.value.offers[provider]) {
      if (row.id !== offerId) continue;
      if (enrollment) row.enrollment = enrollment;
      else delete row.enrollment;
      if (schedule) row.enrollmentSchedule = schedule;
      else delete row.enrollmentSchedule;
    }
    data.value.enrollmentSchedules = (data.value.enrollmentSchedules || []).filter(row => row.offerId !== offerId);
    if (schedule) data.value.enrollmentSchedules.push(schedule);
    data.value.connections[provider] = result.connections[provider];
  }
  async function refreshSchedules() {
    const schedules = data.value.enrollmentSchedules?.filter(row => row.state !== "failed") || [];
    if (!schedules.length || refreshingSchedules || busy.value || !mounted) return;
    refreshingSchedules = true;
    const revision = dataRevision;
    try {
      const result = await $fetch<DashboardData>("/api/dashboard", { timeout: 10_000 });
      if (!mounted || revision !== dataRevision) return;
      for (const previous of schedules) {
        const provider = enrollmentProvider(previous.offerId);
        if (!provider) continue;
        applyEnrollment(result, previous.offerId);
        const schedule = result.enrollmentSchedules?.find(row => row.offerId === previous.offerId);
        if (schedule?.state === "failed") notice.value = { text: schedule.message || "预约报名失败", error: true };
        else if (!schedule && result.offers[provider].some(row => row.id === previous.offerId && row.enrollment?.state === "enrolled"))
          notice.value = { text: "预约报名成功", error: false };
      }
    } catch {} finally {
      refreshingSchedules = false;
    }
  }
  async function enrollmentAction(offerId: string, name: string, task: () => Promise<DashboardData>, text: string, failed?: (message: string) => void) {
    if (actionBusy.value || enrollingOfferIds.value.has(offerId)) return false;
    dataRevision++;
    scheduleAdvanceWindows.value = [];
    enrollingOfferIds.value.add(offerId);
    enrollmentActions.value[offerId] = name;
    notice.value = null;
    try {
      applyEnrollment(await task(), offerId);
      notice.value = { text, error: false };
      return true;
    } catch (error) {
      showError(error);
      failed?.(notice.value!.text);
      try { applyEnrollment(await $fetch<DashboardData>("/api/dashboard"), offerId); } catch {}
      return false;
    } finally {
      enrollingOfferIds.value.delete(offerId);
      delete enrollmentActions.value[offerId];
    }
  }
  async function enroll(offer: Offer) {
    const provider = enrollmentProvider(offer.id);
    if (!provider || provider !== offer.provider || offer.source !== "live" ||
      actionBusy.value || enrollingOfferIds.value.has(offer.id) || offer.enrollment?.state === "enrolled") return;
    if (data.value.connections[provider].state !== "connected") {
      await router.push("/accounts");
      notice.value = { text: `请先登录${providerShortNames[provider]}`, error: false };
      return;
    }
    const checking = offer.enrollment?.state === "unknown";
    await enrollmentAction(offer.id, "enroll", () => post<DashboardData>(`/api/${provider}/enroll`, { offerId: offer.id }), checking ? "报名已确认" : "报名成功");
  }
  async function cancelEnrollment(offer: Offer) {
    const provider = enrollmentProvider(offer.id);
    if (!provider || provider !== offer.provider || offer.source !== "live") return;
    if (offer.enrollment?.state !== "cancel-unknown" && !window.confirm(`取消「${offer.name}」的报名？`)) return;
    await enrollmentAction(offer.id, "cancel", () => post<DashboardData>(`/api/${provider}/cancel`, { offerId: offer.id }), "报名已取消");
  }
  function setScheduleUseAdvance(enabled: boolean) {
    const offer = scheduleOffer.value;
    if (!offer || (enabled && !scheduleAdvanceAvailable.value)) return;
    scheduleUseAdvance.value = enabled;
    scheduleTime.value = defaultScheduleTime(offer, now.value, enabled ? scheduleCouponWindows.value : []);
    scheduleError.value = "";
  }
  async function openSchedule(offer: Offer) {
    const provider = enrollmentProvider(offer.id);
    if (!provider || provider !== offer.provider || offer.source !== "live") return;
    const request = ++scheduleOptionsRequest;
    const revision = dataRevision;
    scheduleRevision = revision;
    scheduleOffer.value = offer;
    scheduleUseAdvance.value = false;
    scheduleAdvanceWindows.value = [];
    scheduleTime.value = defaultScheduleTime(offer, now.value);
    scheduleError.value = "";
    scheduleOptionsError.value = "";
    scheduleLoading.value = provider === "xiaochan" && !!xiaochanAdvanceWindow(offer, now.value);
    scheduleDialog.value?.showModal();
    if (!scheduleLoading.value) return;
    const initialTime = scheduleTime.value;
    const current = () => request === scheduleOptionsRequest && revision === dataRevision &&
      scheduleOffer.value?.id === offer.id && scheduleDialog.value?.open;
    try {
      const result = await post<XiaochanScheduleOptions>("/api/xiaochan/schedule-options", { offerId: offer.id });
      if (!current()) return;
      if (result.offerId !== offer.id || !Array.isArray(result.advanceWindows)) throw new Error("Invalid schedule options");
      scheduleAdvanceWindows.value = result.advanceWindows;
      if (scheduleTime.value === initialTime && scheduleAdvanceAvailable.value)
        setScheduleUseAdvance(true);
    } catch {
      if (!current()) return;
      scheduleAdvanceWindows.value = [];
      scheduleOptionsError.value = "卡券查询失败，可预约普通时段";
    } finally {
      if (request === scheduleOptionsRequest) scheduleLoading.value = false;
    }
  }
  async function saveSchedule() {
    const offer = scheduleOffer.value;
    if (!offer || !scheduleTime.value || scheduleLoading.value) return;
    const provider = enrollmentProvider(offer.id);
    if (!provider || provider !== offer.provider || offer.source !== "live") return;
    scheduleError.value = "";
    if (scheduleRevision !== dataRevision) {
      scheduleError.value = "活动已更新，请重新选择";
      return;
    }
    const localTime = scheduleTime.value.length === 16 ? `${scheduleTime.value}:00` : scheduleTime.value;
    const runAt = `${localTime}+08:00`;
    const selected = Date.parse(runAt);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(localTime) ||
      !scheduleWindows.value.some(window => selected >= window.start && selected < window.end)) {
      scheduleError.value = "请选择有效的报名时间";
      return;
    }
    const request = scheduleOptionsRequest;
    const current = () => request === scheduleOptionsRequest && scheduleOffer.value?.id === offer.id;
    const success = await enrollmentAction(offer.id, "schedule", () => post<DashboardData>(`/api/${provider}/schedule`, {
      offerId: offer.id, runAt,
    }), "预约报名已设置", message => { if (current()) scheduleError.value = message; });
    if (!current()) return;
    if (success) scheduleDialog.value?.close();
    else {
      scheduleRevision = dataRevision;
      scheduleError.value ||= "预约报名设置失败";
      if (notice.value?.text === scheduleError.value) notice.value = null;
    }
  }
  async function cancelSchedule(offerId: string) {
    const provider = enrollmentProvider(offerId);
    if (!provider) return;
    await enrollmentAction(offerId, "schedule", () => $fetch<DashboardData>(`/api/${provider}/schedule`, {
      method: "DELETE", body: { offerId }, headers: { "x-food-request": "1" },
    }), "预约报名已取消");
  }
  async function connectMeituanBrowser() {
    await action("meituan-browser", async () => {
      data.value = await post<DashboardData>("/api/connections/meituan/browser");
      notice.value = { text: "登录成功", error: false };
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

  return {
    loaded, data, busy, enrollingOfferIds, enrollmentActions, now, syncing, notice, filter, sort, requiresCityName,
    scheduleDialog, scheduleOffer, scheduleTime, scheduleError, openSchedule, saveSchedule, cancelSchedule, cancelEnrollment,
    scheduleLoading, scheduleOptionsError, scheduleWindows, scheduleUsesAdvance,
    scheduleUseAdvance, scheduleAdvanceAvailable, scheduleCouponWindows, setScheduleUseAdvance,
    locationDialog, locationForm, locationError,
    sync, connectComputerWeChat, enroll, connectMeituanBrowser,
    disconnect, openLocation, locateAddress, saveLocation,
  };
}

export function provideFoodApp() {
  const food = createFoodApp();
  provide(foodAppKey, food);
  return food;
}

export function useFoodApp() {
  const food = inject(foodAppKey);
  if (!food) throw new Error("Food app context is unavailable");
  return food;
}
