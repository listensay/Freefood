<script setup lang="ts">
import { computed, watch } from "vue";
import UiSelect from "./UiSelect.vue";
const props = defineProps<{ modelValue: string; min: string; max: string; windows?: { min: string; max: string }[] }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const seconds = (value: string) => {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value.slice(11, 19));
  if (!match) return NaN;
  const hour = Number(match[1]), minute = Number(match[2]), second = Number(match[3]);
  return hour < 24 && minute < 60 && second < 60 ? hour * 3600 + minute * 60 + second : NaN;
};
const minimum = computed(() => seconds(props.min));
const maximum = computed(() => seconds(props.max));
type TimeRange = { min: number; max: number };
const windows = computed<TimeRange[]>(() => (props.windows ?? [{ min: props.min, max: props.max }]).flatMap(window => {
  if (window.min.slice(0, 10) !== props.min.slice(0, 10) || window.max.slice(0, 10) !== props.min.slice(0, 10)) return [];
  const min = Math.max(minimum.value, seconds(window.min)), max = Math.min(maximum.value, seconds(window.max));
  return Number.isFinite(min) && Number.isFinite(max) && min <= max ? [{ min, max }] : [];
}).sort((a, b) => a.min - b.min));
const available = (first: number, last = first) => windows.value.some(window => window.min <= last && window.max >= first);
const clamp = (value: number, ranges = windows.value) => {
  if (!ranges.length) return minimum.value;
  if (!Number.isFinite(value)) return ranges[0]!.min;
  for (const range of ranges) {
    if (value < range.min) return range.min;
    if (value <= range.max) return value;
  }
  return ranges.at(-1)!.max;
};
const selected = computed(() => clamp(props.modelValue.slice(0, 10) === props.min.slice(0, 10) ? seconds(props.modelValue) : NaN));
const pad = (value: number) => String(value).padStart(2, "0");
const hour = computed(() => Math.floor(selected.value / 3600));
const minute = computed(() => Math.floor(selected.value / 60) % 60);
const second = computed(() => selected.value % 60);
const range = (first: number, last: number) => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => ({ value: pad(i + first), label: pad(i + first) }));
const hours = computed(() => range(0, 23).filter(option => available(Number(option.value) * 3600, Number(option.value) * 3600 + 3599)));
const minutes = computed(() => range(0, 59).filter(option => {
  const first = hour.value * 3600 + Number(option.value) * 60;
  return available(first, first + 59);
}));
const secondOptions = computed(() => range(0, 59).filter(option => available(hour.value * 3600 + minute.value * 60 + Number(option.value))));
function choose(part: "hour" | "minute" | "second", value: string) {
  if (!windows.value.length) return;
  const h = part === "hour" ? Number(value) : hour.value;
  const m = part === "minute" ? Number(value) : minute.value;
  const s = part === "second" ? Number(value) : second.value;
  const first = h * 3600 + (part === "hour" ? 0 : m * 60);
  const last = first + (part === "hour" ? 3599 : 59);
  const ranges = windows.value.flatMap(window => {
    const min = Math.max(first, window.min), max = Math.min(last, window.max);
    return min <= max ? [{ min, max }] : [];
  });
  if (!ranges.length) return;
  const time = clamp(h * 3600 + m * 60 + s, ranges);
  emit("update:modelValue", `${props.min.slice(0, 10)}T${pad(Math.floor(time / 3600))}:${pad(Math.floor(time / 60) % 60)}:${pad(time % 60)}`);
}
watch(() => [props.min, props.max, props.windows, props.modelValue], () => {
  const current = seconds(props.modelValue);
  if (!Number.isFinite(current) || !available(current) || props.modelValue.slice(0, 10) !== props.min.slice(0, 10))
    choose("hour", pad(hour.value));
}, { immediate: true, deep: true });
</script>

<template>
  <div class="time-picker" role="group" aria-label="报名时间（北京时间）">
    <div><span>时</span><UiSelect :model-value="pad(hour)" :options="hours" label="报名小时" @update:model-value="choose('hour', $event)" /></div>
    <span class="time-separator" aria-hidden="true">:</span>
    <div><span>分</span><UiSelect :model-value="pad(minute)" :options="minutes" label="报名分钟" @update:model-value="choose('minute', $event)" /></div>
    <span class="time-separator" aria-hidden="true">:</span>
    <div><span>秒</span><UiSelect :model-value="pad(second)" :options="secondOptions" label="报名秒钟" @update:model-value="choose('second', $event)" /></div>
  </div>
</template>
