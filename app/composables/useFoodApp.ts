import type { InjectionKey } from "vue";
import type { BawangcanProvider, DashboardData, Provider, Offer } from "#shared/types";
import { addressFromGeocode } from "#shared/utils/location";
import { defaultEnrollmentTime } from "#shared/utils/enrollment-time";

const foodAppKey: InjectionKey<ReturnType<typeof createFoodApp>> = Symbol("food-app");

function createFoodApp() {
  const loaded = ref(false);
  const route = useRoute();
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
  const busy = computed(() => actionBusy.value || (enrollingOfferIds.value.size ? "enroll" : ""));
  const syncing = ref(false),
    notice = ref<{ text: string; error: boolean; source?: "sync" } | null>(null);
  const filter = ref("all"),
    sort = ref("price");
  const bawangcanProvider = ref<BawangcanProvider>("xiaochan");
  const locationDialog = ref<HTMLDialogElement>();
  const locationForm = ref({
    label: "",
    cityName: "",
    cityCode: undefined as number | undefined,
    latitude: undefined as number | undefined,
    longitude: undefined as number | undefined,
  });
  const locationError = ref("");
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;
  let refreshingSchedules = false;
  let mounted = false;
  let dataRevision = 0;
  let pendingCombinationSync = false;
  const refreshingProfiles = new Set<BawangcanProvider>();
  watch(() => route.path, () => {
    filter.value = "all";
    if (!mounted || !loaded.value) return;
    if (route.path === "/") void sync(true);
    if (route.path === "/accounts") void refreshProfiles();
  });
  onMounted(async () => {
    mounted = true;
    try {
      const savedProvider = localStorage.getItem("food-bawangcan-provider");
      if (savedProvider === "xiaochan" || savedProvider === "waimai")
        bawangcanProvider.value = savedProvider;
    } catch {}
    try {
      data.value = await $fetch<DashboardData>("/api/dashboard", { timeout: 10_000 });
    } catch (error) {
      showError(error);
    }
    loaded.value = true;
    if (mounted) {
      void refreshProfiles();
      syncTimer = setInterval(() => { void sync(true); }, 5 * 60_000);
      scheduleTimer = setInterval(() => { now.value = new Date(); void refreshSchedules(); }, 1000);
      if (route.path === "/" && !data.value.location) await locateAddress();
      void sync(true);
    }
  });
  onBeforeUnmount(() => {
    mounted = false;
    clearInterval(syncTimer);
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
    actionBusy.value = name;
    notice.value = null;
    try {
      await task();
    } catch (error) {
      showError(error);
    } finally {
      actionBusy.value = "";
      if (pendingCombinationSync) void sync(true);
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
      (data.value.connections[bawangcanProvider.value].state !== "connected" &&
        !["connected", "configured"].includes(data.value.connections.meituan.state)) ||
      (bawangcanProvider.value === "waimai" &&
        data.value.connections.waimai.state === "connected" && !data.value.location.cityName)
    )) return;
    if (!data.value.location) {
      if (!(await locateAddress())) {
        openLocation();
        return;
      }
    }
    if (
      data.value.connections[bawangcanProvider.value].state !== "connected" &&
      !["connected", "configured"].includes(data.value.connections.meituan.state)
    ) {
      await navigateTo("/accounts");
      notice.value = {
        text: "请先连接平台账号",
        error: false,
      };
      return;
    }
    if (
      bawangcanProvider.value === "waimai" &&
      data.value.connections.waimai.state === "connected" &&
      !data.value.location?.cityName
    ) {
      openLocation();
      return;
    }
    syncing.value = true;
    pendingCombinationSync = false;
    const provider = bawangcanProvider.value;
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
        }>("/api/sync", { provider });
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
      if (mounted && (pendingCombinationSync || provider !== bawangcanProvider.value)) void sync(true);
    }
  }
  async function connectComputerWeChat(provider: BawangcanProvider) {
    await action(`${provider}-wechat`, async () => {
      data.value = await post<DashboardData>(`/api/connections/${provider}/wechat`);
      notice.value = { text: "登录成功", error: false };
    });
  }
  function applyEnrollment(result: DashboardData, offerId: string) {
    const enrollment = result.offers.xiaochan.find(row => row.id === offerId)?.enrollment;
    const schedule = result.enrollmentSchedules?.find(row => row.offerId === offerId);
    for (const row of data.value.offers.xiaochan) {
      if (row.id !== offerId) continue;
      if (enrollment) row.enrollment = enrollment;
      else delete row.enrollment;
      if (schedule) row.enrollmentSchedule = schedule;
      else delete row.enrollmentSchedule;
    }
    data.value.enrollmentSchedules = (data.value.enrollmentSchedules || []).filter(row => row.offerId !== offerId);
    if (schedule) data.value.enrollmentSchedules.push(schedule);
    data.value.connections.xiaochan = result.connections.xiaochan;
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
        applyEnrollment(result, previous.offerId);
        const schedule = result.enrollmentSchedules?.find(row => row.offerId === previous.offerId);
        if (schedule?.state === "failed") notice.value = { text: schedule.message || "预约报名失败", error: true };
        else if (!schedule && result.offers.xiaochan.some(row => row.id === previous.offerId && row.enrollment?.state === "enrolled"))
          notice.value = { text: "预约报名成功", error: false };
      }
    } catch {} finally {
      refreshingSchedules = false;
    }
  }
  async function enrollmentAction(offerId: string, name: string, task: () => Promise<DashboardData>, text: string, failed?: (message: string) => void) {
    if (actionBusy.value || enrollingOfferIds.value.has(offerId)) return false;
    dataRevision++;
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
      if (pendingCombinationSync) void sync(true);
    }
  }
  async function enrollXiaochan(offer: Offer) {
    if (actionBusy.value || enrollingOfferIds.value.has(offer.id) || offer.enrollment?.state === "enrolled") return;
    if (data.value.connections.xiaochan.state !== "connected") {
      await navigateTo("/accounts");
      notice.value = { text: "请先登录小蚕", error: false };
      return;
    }
    const checking = offer.enrollment?.state === "unknown";
    await enrollmentAction(offer.id, "enroll", () => post<DashboardData>("/api/xiaochan/enroll", { offerId: offer.id }), checking ? "报名已确认" : "报名成功");
  }
  async function cancelEnrollment(offer: Offer) {
    if (offer.enrollment?.state !== "cancel-unknown" && !window.confirm(`取消「${offer.name}」的报名？`)) return;
    await enrollmentAction(offer.id, "cancel", () => post<DashboardData>("/api/xiaochan/cancel", { offerId: offer.id }), "报名已取消");
  }
  function openSchedule(offer: Offer) {
    scheduleOffer.value = offer;
    scheduleTime.value = defaultEnrollmentTime(offer, now.value);
    scheduleError.value = "";
    scheduleDialog.value?.showModal();
  }
  async function saveSchedule() {
    if (!scheduleOffer.value || !scheduleTime.value) return;
    scheduleError.value = "";
    const success = await enrollmentAction(scheduleOffer.value.id, "schedule", () => post<DashboardData>("/api/xiaochan/schedule", {
      offerId: scheduleOffer.value!.id, runAt: `${scheduleTime.value.length === 16 ? scheduleTime.value + ':00' : scheduleTime.value}+08:00`,
    }), "预约报名已设置", message => { scheduleError.value = message; });
    if (success) scheduleDialog.value?.close();
    else {
      scheduleError.value ||= "预约报名设置失败";
      if (notice.value?.text === scheduleError.value) notice.value = null;
    }
  }
  async function cancelSchedule(offerId: string) {
    await enrollmentAction(offerId, "schedule", () => $fetch<DashboardData>("/api/xiaochan/schedule", {
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
  function changeCombination(provider: BawangcanProvider) {
    if (provider === bawangcanProvider.value) return;
    bawangcanProvider.value = provider;
    try {
      localStorage.setItem("food-bawangcan-provider", provider);
    } catch {}
    filter.value = "all";
    pendingCombinationSync = true;
    if (mounted && loaded.value) void sync(true);
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
    loaded, data, busy, enrollingOfferIds, enrollmentActions, now, syncing, notice, filter, sort, bawangcanProvider,
    scheduleDialog, scheduleOffer, scheduleTime, scheduleError, openSchedule, saveSchedule, cancelSchedule, cancelEnrollment,
    locationDialog, locationForm, locationError,
    sync, changeCombination, connectComputerWeChat, enrollXiaochan, connectMeituanBrowser,
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
