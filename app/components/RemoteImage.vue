<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  src?: string;
  fallbackSrc?: string;
  alt: string;
  loading?: "eager" | "lazy";
}>();
const sources = computed(() => [...new Set([props.src, props.fallbackSrc].filter((url): url is string => !!url))]);
const sourceIndex = ref(0), failed = ref(false), version = ref(0);
const source = computed(() => sources.value[sourceIndex.value]);
const image = ref<HTMLImageElement>();
const retryDelays = [500, 1500];
let attempts = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function clearRetry() {
  clearTimeout(timer);
  timer = undefined;
}
function reset() {
  clearRetry();
  sourceIndex.value = 0;
  attempts = 0;
  failed.value = false;
  version.value++;
}
function onError(event: Event) {
  // Late events from a replaced image must not affect its new source.
  if (event.target !== image.value || failed.value) return;
  failed.value = true;
  const delay = retryDelays[attempts++];
  if (delay !== undefined) {
    const currentVersion = version.value;
    timer = setTimeout(() => {
      timer = undefined;
      if (version.value !== currentVersion) return;
      version.value++;
      failed.value = false;
    }, delay);
  } else if (sourceIndex.value + 1 < sources.value.length) {
    sourceIndex.value++;
    attempts = 0;
    version.value++;
    failed.value = false;
  }
}
function onOnline() {
  if (failed.value) reset();
}
watch(() => [props.src, props.fallbackSrc], reset, { flush: "sync" });
onMounted(() => window.addEventListener("online", onOnline));
onBeforeUnmount(() => {
  clearRetry();
  window.removeEventListener("online", onOnline);
});
</script>

<template>
  <img v-if="source && !failed" :key="version" ref="image" :src="source" :alt="alt"
    :loading="loading" referrerpolicy="no-referrer" @error="onError" />
  <slot v-else />
</template>
