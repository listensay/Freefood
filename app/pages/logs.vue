<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { Download, RefreshCw, Trash2, ChevronDown } from "@lucide/vue";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { apiFetch } from "../lib/api";
import UiSelect from "../components/UiSelect.vue";
import { providerShortNames } from "#shared/types";
import { logActions, logSources, logReasons, logSummary, type RuntimeLog, type LogPage, type LogExport } from "#shared/runtime-logs";

const entries = ref<RuntimeLog[]>([]), total = ref(0), nextCursor = ref<number>();
const provider = ref(""), reason = ref("");
const loading = ref(false), clearing = ref(false), exporting = ref(false), loaded = ref(false);
const error = ref(""), message = ref(""), dropped = ref(0);
const confirmDialog = ref<HTMLDialogElement>();
const platforms = [{ value: "", label: "全部平台" }, ...Object.entries(providerShortNames).map(([value, label]) => ({ value, label }))];
const reasons = [{ value: "", label: "全部结果" }, { value: "failure", label: "全部异常" },
  ...Object.entries(logReasons).map(([value, label]) => ({ value, label }))];
const buttonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-sm border border-hairline bg-canvas px-4 py-2 text-[14px] font-semibold not-disabled:hover:bg-surface-soft disabled:text-muted";
let revision = 0, mounted = true, timer: ReturnType<typeof setInterval> | undefined;
const time = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value));
const duration = (value?: number) => value === undefined ? "—" : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;

async function refresh(append = false, silent = false) {
  const request = ++revision;
  loading.value = true;
  if (!silent) error.value = "";
  try {
    const result = await apiFetch<LogPage>("/api/logs/query", { method: "POST", headers: { "x-food-request": "1" }, body: {
      ...(provider.value ? { provider: provider.value } : {}),
      ...(reason.value === "failure" ? { level: "error" } : reason.value ? { reason: reason.value } : {}),
      ...(append && nextCursor.value ? { before: nextCursor.value } : {}),
    } });
    if (!mounted || request !== revision) return;
    entries.value = append ? [...entries.value, ...result.entries] : result.entries;
    total.value = result.total; nextCursor.value = result.nextCursor; dropped.value = result.droppedEvents;
    loaded.value = true; error.value = "";
  } catch {
    if (mounted && request === revision) error.value = "日志加载失败";
  } finally { if (mounted && request === revision) loading.value = false; }
}
async function clear() {
  confirmDialog.value?.close();
  ++revision; loading.value = false; clearing.value = true; error.value = ""; message.value = "";
  try {
    await apiFetch("/api/logs", { method: "DELETE", headers: { "x-food-request": "1" } });
    if (!mounted) return;
    entries.value = []; total.value = 0; nextCursor.value = undefined; dropped.value = 0; loaded.value = true;
    message.value = "日志已清空";
  } catch { if (mounted) error.value = "清空失败"; }
  finally { clearing.value = false; }
}
async function download() {
  exporting.value = true; error.value = ""; message.value = "";
  try {
    if (isTauri()) {
      await invoke("export_runtime_logs");
      if (mounted) message.value = "已导出到下载文件夹";
    } else {
      const data = await apiFetch<LogExport>("/api/logs/export");
      if (!mounted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `freefood-logs-${data.exportedAt.replace(/[:.]/g, "-")}.json`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      message.value = "日志已导出";
    }
  } catch { if (mounted) error.value = "导出失败"; }
  finally { exporting.value = false; }
}
watch([provider, reason], () => { message.value = ""; entries.value = []; nextCursor.value = undefined; void refresh(); });
onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (!document.hidden && !loading.value && !clearing.value && entries.value.length <= 100) void refresh(false, true);
  }, 5000);
});
onBeforeUnmount(() => { mounted = false; ++revision; clearInterval(timer); });
</script>

<template>
  <div class="logs-page">
    <section class="page-heading mb-8 flex flex-wrap items-center justify-between gap-6 mobile:mb-6 mobile:gap-4">
      <h1>运行日志</h1>
      <div class="flex flex-wrap gap-2">
        <button :class="buttonClass" :disabled="loading || clearing" @click="refresh()"><RefreshCw :size="16" />刷新</button>
        <button :class="buttonClass" :disabled="exporting || clearing" @click="download"><Download :size="16" />{{ exporting ? "导出中…" : "导出日志" }}</button>
        <button :class="buttonClass" :disabled="clearing || exporting" @click="confirmDialog?.showModal()"><Trash2 :size="16" />{{ clearing ? "清空中…" : "清空日志" }}</button>
      </div>
    </section>
    <div class="mb-6 flex flex-wrap items-center gap-3">
      <UiSelect v-model="provider" :options="platforms" label="日志平台" :disabled="clearing" />
      <UiSelect v-model="reason" :options="reasons" label="日志结果" :disabled="clearing" />
      <span v-if="loaded" class="ml-auto text-[14px] text-muted">{{ total }} 条</span>
    </div>
    <p v-if="error" class="mb-4 text-[14px] text-primary-error-text" role="alert">{{ error }}</p>
    <p v-else-if="message" class="mb-4 text-[14px] text-muted" role="status">{{ message }}</p>
    <p v-if="dropped" class="mb-4 text-[14px] text-primary-error-text" role="status">部分日志未能保存</p>
    <section class="overflow-hidden rounded-md border border-hairline-soft bg-canvas" aria-label="日志列表" :aria-busy="loading">
      <div v-if="!entries.length" class="p-12 text-center text-[14px] text-muted" role="status">{{ loading ? "加载中…" : error && !loaded ? "暂无日志数据" : "暂无日志" }}</div>
      <details v-for="entry in entries" :key="entry.id" class="log-entry group border-b border-hairline-soft last:border-b-0">
        <summary class="grid cursor-pointer list-none grid-cols-[142px_52px_100px_minmax(0,1fr)_72px_16px] items-center gap-4 px-6 py-4 text-[14px] hover:bg-surface-soft [&::-webkit-details-marker]:hidden tablet:gap-3 tablet:px-4 mobile:grid-cols-[1fr_auto_16px]">
          <time :datetime="entry.timestamp" class="text-[13px] whitespace-nowrap text-muted mobile:col-span-1">{{ time(entry.timestamp) }}</time>
          <span class="mobile:col-start-2 mobile:row-start-1">{{ entry.provider ? providerShortNames[entry.provider] : "系统" }}</span>
          <span class="mobile:col-span-1 mobile:row-start-2">{{ logActions[entry.action] }}</span>
          <span class="wrap-anywhere mobile:col-span-2 mobile:col-start-1 mobile:row-start-3" :class="entry.outcome === 'failure' ? 'text-primary-error-text' : 'text-muted'">{{ logSummary(entry) }}</span>
          <span class="text-right text-[13px] whitespace-nowrap text-muted mobile:col-start-2 mobile:row-start-2">{{ duration(entry.durationMs) }}</span>
          <ChevronDown :size="16" class="text-muted transition-transform group-open:rotate-180 mobile:col-start-3 mobile:row-span-3 mobile:row-start-1" />
        </summary>
        <dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-t border-hairline-soft bg-surface-soft px-6 py-4 text-[13px] mobile:gap-x-3 mobile:px-4 [&>dt]:text-muted [&>dd]:m-0 [&>dd]:wrap-anywhere">
          <dt>来源</dt><dd>{{ logSources[entry.source] }}</dd>
          <template v-if="entry.httpStatus !== undefined"><dt>HTTP 状态</dt><dd>{{ entry.httpStatus }}</dd></template>
          <template v-if="entry.businessCode !== undefined"><dt>业务状态</dt><dd>{{ entry.businessCode }}</dd></template>
          <template v-if="entry.endpoint"><dt>接口</dt><dd>{{ entry.method }} {{ entry.endpoint }}</dd></template>
          <template v-if="entry.rpc"><dt>RPC</dt><dd>{{ entry.rpc }}</dd></template>
          <template v-if="entry.client"><dt>客户端</dt><dd>{{ entry.client }} {{ entry.clientVersion }}</dd></template>
          <template v-if="entry.page !== undefined"><dt>页码</dt><dd>{{ entry.page }}</dd></template>
          <template v-if="entry.gapMs !== undefined"><dt>请求间隔</dt><dd>{{ duration(entry.gapMs) }}</dd></template>
          <template v-if="entry.scheduledAt"><dt>预约时间</dt><dd>{{ time(entry.scheduledAt) }}</dd></template>
          <dt>任务编号</dt><dd class="font-mono">{{ entry.traceId }}</dd>
        </dl>
      </details>
    </section>
    <div v-if="nextCursor" class="mt-6 flex justify-center"><button :class="buttonClass" :disabled="loading || clearing" @click="refresh(true)">{{ loading ? "加载中…" : "加载更多" }}</button></div>
    <dialog ref="confirmDialog" class="w-[360px] max-w-[calc(100vw-32px)] rounded-md p-6" aria-labelledby="clear-log-title" @click="$event.target === confirmDialog && confirmDialog?.close()">
      <h2 id="clear-log-title">清空全部日志？</h2>
      <div class="mt-6 flex justify-end gap-3">
        <button :class="buttonClass" autofocus @click="confirmDialog?.close()">取消</button>
        <button :class="buttonClass" @click="clear">清空</button>
      </div>
    </dialog>
  </div>
</template>
