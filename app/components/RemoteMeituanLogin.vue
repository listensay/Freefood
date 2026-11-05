<script setup lang="ts">
import { ArrowDown, ArrowUp, RefreshCw, ShieldCheck, X } from "@lucide/vue";
import type {
  DashboardData,
  RemoteBrowserAction,
  RemoteLoginSession,
} from "#shared/types";
import { MEITUAN_LOGIN_URL } from "#shared/meituan";

const emit = defineEmits<{
  connected: [data: DashboardData];
  updated: [data: DashboardData];
  importRequested: [];
}>();
const dialog = ref<HTMLDialogElement>();
const surface = ref<HTMLDivElement>();
const session = ref<RemoteLoginSession>();
const frame = ref("");
const opening = ref(false),
  verifying = ref(false),
  ready = ref(false),
  error = ref(""),
  text = ref(""),
  sendingText = ref(false);
const loginIssue = ref("");
const loginIssueMessages: Record<string, string> = {
  rejected: "美团拒绝登录请求，请使用浏览器登录",
  network: "美团登录请求失败，请检查网络",
  verification: "请在官方页面完成安全验证",
};
const loginIssueMessage = computed(
  () => loginIssueMessages[loginIssue.value] || "",
);
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let frameRequest: AbortController | undefined;
let verifyRequest: AbortController | undefined;
let inputQueue: Promise<void> = Promise.resolve();
let pointerId: number | undefined;
let moveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingMove: RemoteBrowserAction | undefined;

function message(cause: any) {
  return (
    cause.data?.statusMessage ||
    cause.statusMessage ||
    "登录页面连接失败，请重试"
  );
}
const headers = (token: string) => ({
  "x-food-request": "1",
  "x-food-browser": token,
});
function stopFrames() {
  clearTimeout(timer);
  frameRequest?.abort();
  frameRequest = undefined;
}
function clearFrame() {
  if (frame.value) URL.revokeObjectURL(frame.value);
  frame.value = "";
}
async function readFrame(version: number) {
  const current = session.value;
  if (
    !current ||
    version !== generation ||
    verifying.value ||
    document.hidden ||
    !dialog.value?.open
  )
    return;
  const controller = new AbortController();
  frameRequest = controller;
  try {
    const response = await fetch("/api/connections/meituan/remote/frame", {
      headers: headers(current.token),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw { data, status: response.status };
    }
    const image = await response.blob();
    if (version !== generation || controller.signal.aborted) return;
    const previous = frame.value;
    frame.value = URL.createObjectURL(image);
    if (previous) URL.revokeObjectURL(previous);
    ready.value = true;
    const issue = response.headers.get("x-food-login-issue") || "";
    loginIssue.value = ["rejected", "network", "verification"].includes(issue)
      ? issue
      : "";
  } catch (cause: any) {
    if (version !== generation || controller.signal.aborted) return;
    error.value = message(cause);
    ready.value = false;
    return;
  } finally {
    if (frameRequest === controller) frameRequest = undefined;
  }
  if (version === generation && !verifying.value && !document.hidden)
    timer = setTimeout(() => {
      void readFrame(version);
    }, 650);
}

async function open() {
  const version = ++generation;
  stopFrames();
  clearFrame();
  clearTimeout(moveTimer);
  pendingMove = undefined;
  pointerId = undefined;
  text.value = "";
  error.value = "";
  loginIssue.value = "";
  ready.value = false;
  opening.value = true;
  verifying.value = false;
  sendingText.value = false;
  inputQueue = Promise.resolve();
  await nextTick();
  if (!dialog.value?.open) dialog.value?.showModal();
  try {
    const result = await $fetch<RemoteLoginSession>(
      "/api/connections/meituan/start",
      { method: "POST", headers: { "x-food-request": "1" } },
    );
    if (version !== generation) {
      void $fetch("/api/connections/meituan/remote/end", {
        method: "POST",
        headers: headers(result.token),
      }).catch(() => {});
      return;
    }
    session.value = result;
    await readFrame(version);
  } catch (cause) {
    if (version === generation) error.value = message(cause);
  } finally {
    if (version === generation) opening.value = false;
  }
}

function send(action: RemoteBrowserAction) {
  const current = session.value,
    version = generation;
  if (!current || !ready.value || verifying.value) return;
  inputQueue = inputQueue
    .catch(() => {})
    .then(async () => {
      if (version !== generation) return;
      try {
        await $fetch("/api/connections/meituan/remote/input", {
          method: "POST",
          headers: headers(current.token),
          body: action,
        });
      } catch (cause) {
        if (version === generation) error.value = message(cause);
      }
    });
}
function point(event: PointerEvent) {
  const current = session.value,
    bounds = surface.value?.querySelector("img")?.getBoundingClientRect();
  if (!current || !bounds?.width || !bounds.height) return;
  return {
    x: Math.max(
      0,
      Math.min(
        current.viewport.width - 1,
        ((event.clientX - bounds.left) / bounds.width) * current.viewport.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        current.viewport.height - 1,
        ((event.clientY - bounds.top) / bounds.height) *
          current.viewport.height,
      ),
    ),
  };
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || !ready.value || verifying.value) return;
  const position = point(event);
  if (!position) return;
  event.preventDefault();
  pointerId = event.pointerId;
  surface.value?.setPointerCapture(event.pointerId);
  surface.value?.focus({ preventScroll: true });
  send({ type: "pointer", phase: "down", ...position });
}
function flushMove() {
  clearTimeout(moveTimer);
  moveTimer = undefined;
  if (pendingMove) send(pendingMove);
  pendingMove = undefined;
}
function pointerMove(event: PointerEvent) {
  if (pointerId !== event.pointerId) return;
  const position = point(event);
  if (!position) return;
  pendingMove = { type: "pointer", phase: "move", ...position };
  if (!moveTimer) moveTimer = setTimeout(flushMove, 65);
}
function pointerUp(event: PointerEvent) {
  if (pointerId !== event.pointerId) return;
  flushMove();
  const position = point(event);
  if (position) send({ type: "pointer", phase: "up", ...position });
  pointerId = undefined;
  if (surface.value?.hasPointerCapture(event.pointerId))
    surface.value.releasePointerCapture(event.pointerId);
}
function keydown(event: KeyboardEvent) {
  if (
    !ready.value ||
    verifying.value ||
    event.isComposing ||
    event.key === "Escape"
  )
    return;
  let action: RemoteBrowserAction | undefined;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
    action = { type: "key", key: "ControlOrMeta+A" };
  else if (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key.length === 1
  )
    action = { type: "text", text: event.key };
  else if (
    [
      "Backspace",
      "Delete",
      "Tab",
      "Enter",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(event.key)
  )
    action = {
      type: "key",
      key: event.key === "Tab" && event.shiftKey ? "Shift+Tab" : event.key,
    };
  if (action) {
    event.preventDefault();
    send(action);
  }
}
function wheel(event: WheelEvent) {
  send({
    type: "wheel",
    deltaX: Math.max(-2000, Math.min(2000, event.deltaX)),
    deltaY: Math.max(-2000, Math.min(2000, event.deltaY)),
  });
}
async function insertText() {
  if (
    !text.value ||
    text.value.length > 2000 ||
    !ready.value ||
    verifying.value
  )
    return;
  error.value = "";
  const version = generation;
  sendingText.value = true;
  send({ type: "text", text: text.value });
  await inputQueue;
  if (version !== generation) return;
  sendingText.value = false;
  if (!error.value) text.value = "";
  surface.value?.focus({ preventScroll: true });
}
async function verify() {
  const current = session.value,
    version = generation;
  if (!current || verifying.value || loginIssue.value === "rejected") return;
  flushMove();
  await inputQueue;
  if (version !== generation) return;
  verifying.value = true;
  error.value = "";
  stopFrames();
  const controller = new AbortController();
  verifyRequest = controller;
  try {
    const data = await $fetch<DashboardData>(
      "/api/connections/meituan/remote/verify",
      {
        method: "POST",
        headers: headers(current.token),
        signal: controller.signal,
      },
    );
    if (version !== generation) return;
    emit("connected", data);
    close(false);
  } catch (cause) {
    if (version === generation) error.value = message(cause);
  } finally {
    if (verifyRequest === controller) verifyRequest = undefined;
    if (version === generation) {
      verifying.value = false;
      void readFrame(version);
    }
  }
}
function close(release = true) {
  if (!dialog.value?.open && !session.value && !opening.value) return;
  const current = session.value,
    version = ++generation;
  stopFrames();
  verifyRequest?.abort();
  clearTimeout(moveTimer);
  pendingMove = undefined;
  pointerId = undefined;
  session.value = undefined;
  opening.value = false;
  verifying.value = false;
  sendingText.value = false;
  ready.value = false;
  text.value = "";
  clearFrame();
  dialog.value?.close();
  if (current && release)
    void $fetch<DashboardData>("/api/connections/meituan/remote/end", {
      method: "POST",
      headers: headers(current.token),
      keepalive: true,
    })
      .then((data) => {
        if (version === generation) emit("updated", data);
      })
      .catch(() => {});
}
function browserLogin() {
  close();
  emit("importRequested");
}
const pageHidden = () => close();
function visibilityChanged() {
  if (document.hidden) stopFrames();
  else if (session.value && dialog.value?.open && !verifying.value)
    void readFrame(generation);
}
onMounted(() => {
  window.addEventListener("pagehide", pageHidden);
  document.addEventListener("visibilitychange", visibilityChanged);
});
onBeforeUnmount(() => {
  window.removeEventListener("pagehide", pageHidden);
  document.removeEventListener("visibilitychange", visibilityChanged);
  close();
});
defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="remote-login-dialog"
    aria-label="美团登录"
    @cancel.prevent="close()"
    @close="close()"
  >
    <div class="remote-login-content" :class="{ 'has-login-issue': !!loginIssueMessage }">
      <header class="dialog-header">
        <h2>美团登录</h2>
        <button class="icon-button" aria-label="关闭美团登录" @click="close()">
          <X :size="21" />
        </button>
      </header>
      <div
        v-if="frame"
        ref="surface"
        class="remote-browser-surface"
        :class="{ inactive: !ready || verifying }"
        :style="{
          aspectRatio: `${session?.viewport.width || 480} / ${session?.viewport.height || 680}`,
        }"
        tabindex="0"
        role="application"
        aria-label="美团官方页面"
        :aria-busy="verifying"
        @pointerdown="pointerDown"
        @pointermove="pointerMove"
        @pointerup="pointerUp"
        @pointercancel="pointerUp"
        @keydown="keydown"
        @wheel.prevent="wheel"
        @contextmenu.prevent
      >
        <img :src="frame" alt="美团官方登录页面" draggable="false" />
      </div>
      <div v-else class="remote-login-placeholder" role="status">
        <RefreshCw v-if="opening" :size="24" class="spinning" />
        <span>{{ opening ? "加载登录页面…" : "登录页面未连接" }}</span>
      </div>
      <p v-if="error" class="inline-error remote-login-error" role="alert">
        {{ error }}
      </p>
      <p
        v-if="loginIssueMessage"
        class="inline-error remote-login-error"
        role="alert"
      >
        {{ loginIssueMessage }}
      </p>
      <a
        v-if="loginIssue === 'rejected' || loginIssue === 'network'"
        class="button secondary full-width"
        :href="MEITUAN_LOGIN_URL"
        target="_blank"
        rel="noopener noreferrer"
        @click="browserLogin"
        >浏览器登录</a
      >
      <button
        v-if="!ready && !opening"
        class="button secondary full-width"
        @click="open"
      >
        重新连接
      </button>
      <form class="remote-text-entry" @submit.prevent="insertText">
        <input
          v-model="text"
          aria-label="向美团页面输入"
          placeholder="输入内容"
          autocomplete="off"
          maxlength="2000"
          :disabled="!ready || verifying || sendingText"
        />
        <button
          class="button secondary"
          :disabled="!text || !ready || verifying || sendingText"
        >
          输入
        </button>
      </form>
      <footer class="remote-login-actions">
        <button
          class="button secondary"
          aria-label="向上滚动美团页面"
          :disabled="!ready || verifying"
          @click="send({ type: 'wheel', deltaX: 0, deltaY: -300 })"
        >
          <ArrowUp :size="16" />
        </button>
        <button
          class="button secondary"
          aria-label="向下滚动美团页面"
          :disabled="!ready || verifying"
          @click="send({ type: 'wheel', deltaX: 0, deltaY: 300 })"
        >
          <ArrowDown :size="16" />
        </button>
        <button
          class="button secondary"
          aria-label="刷新美团页面"
          :disabled="!ready || verifying"
          @click="send({ type: 'reload' })"
        >
          <RefreshCw :size="16" />
        </button>
        <button
          class="button primary"
          :disabled="!ready || verifying || loginIssue === 'rejected'"
          @click="verify"
        >
          <ShieldCheck :size="16" />{{ verifying ? "验证中…" : "验证登录" }}
        </button>
      </footer>
    </div>
  </dialog>
</template>
