<script setup lang="ts">
const props = defineProps<{ modelValue: string; min: string; max: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const seconds = (value: string) => {
  const parts = value.slice(11, 19).split(":").map(Number);
  return parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : NaN;
};
const minimum = computed(() => seconds(props.min));
const maximum = computed(() => seconds(props.max));
const selected = computed(() => Math.max(minimum.value, Math.min(maximum.value, seconds(props.modelValue) || minimum.value)));
const pad = (value: number) => String(value).padStart(2, "0");
const hour = computed(() => Math.floor(selected.value / 3600));
const minute = computed(() => Math.floor(selected.value / 60) % 60);
const second = computed(() => selected.value % 60);
const range = (first: number, last: number) => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => ({ value: pad(i + first), label: pad(i + first) }));
const hours = computed(() => range(Math.floor(minimum.value / 3600), Math.floor(maximum.value / 3600)));
const minutes = computed(() => range(
  hour.value === Math.floor(minimum.value / 3600) ? Math.floor(minimum.value / 60) % 60 : 0,
  hour.value === Math.floor(maximum.value / 3600) ? Math.floor(maximum.value / 60) % 60 : 59,
));
const secondOptions = computed(() => {
  const currentMinute = hour.value * 60 + minute.value;
  return range(currentMinute === Math.floor(minimum.value / 60) ? minimum.value % 60 : 0,
    currentMinute === Math.floor(maximum.value / 60) ? maximum.value % 60 : 59);
});
function choose(part: "hour" | "minute" | "second", value: string) {
  const h = part === "hour" ? Number(value) : hour.value;
  const m = part === "minute" ? Number(value) : minute.value;
  const s = part === "second" ? Number(value) : second.value;
  const time = Math.max(minimum.value, Math.min(maximum.value, h * 3600 + m * 60 + s));
  emit("update:modelValue", `${props.min.slice(0, 10)}T${pad(Math.floor(time / 3600))}:${pad(Math.floor(time / 60) % 60)}:${pad(time % 60)}`);
}
watch(() => [props.min, props.max], () => {
  const current = seconds(props.modelValue);
  if (!Number.isFinite(current) || current < minimum.value || current > maximum.value || props.modelValue.slice(0, 10) !== props.min.slice(0, 10))
    choose("hour", pad(hour.value));
}, { immediate: true });
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
