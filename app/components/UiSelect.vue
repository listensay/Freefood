<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useId } from "vue";
import { Check, ChevronDown } from "@lucide/vue";

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
  variant?: "default" | "time";
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const id = useId();
const root = ref<HTMLDivElement>();
const trigger = ref<HTMLButtonElement>();
const list = ref<HTMLUListElement>();
const expanded = ref(false);
const opensAbove = ref(false);
const activeIndex = ref(0);
const selected = computed(() =>
  props.options.find((option) => option.value === props.modelValue),
);

async function open(edge?: "first" | "last") {
  if (props.disabled || !props.options.length) return;
  activeIndex.value = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.modelValue),
  );
  if (edge === "first") activeIndex.value = 0;
  if (edge === "last") activeIndex.value = props.options.length - 1;
  expanded.value = true;
  await nextTick();
  const bounds = trigger.value?.getBoundingClientRect();
  if (bounds && list.value) {
    const spaceBelow = window.innerHeight - bounds.bottom;
    opensAbove.value =
      spaceBelow < list.value.offsetHeight + 8 && bounds.top > spaceBelow;
  }
  scrollActive();
  list.value?.focus({ preventScroll: true });
}
function scrollActive() {
  const element = list.value?.children[activeIndex.value] as HTMLElement | undefined;
  if (!element || !list.value || list.value.scrollHeight <= list.value.clientHeight) return;
  if (element.offsetTop < list.value.scrollTop) list.value.scrollTop = element.offsetTop;
  else if (element.offsetTop + element.offsetHeight > list.value.scrollTop + list.value.clientHeight)
    list.value.scrollTop = element.offsetTop + element.offsetHeight - list.value.clientHeight;
}
function close(restoreFocus = false) {
  expanded.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function choose(index: number) {
  const option = props.options[index];
  if (!option) return;
  emit("update:modelValue", option.value);
  close(true);
}
function move(direction: number) {
  activeIndex.value =
    (activeIndex.value + direction + props.options.length) %
    props.options.length;
  scrollActive();
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Tab") {
    close();
    trigger.value?.focus({ preventScroll: true });
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (
    ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)
  ) {
    event.preventDefault();
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Home") activeIndex.value = 0;
    else if (event.key === "End") activeIndex.value = props.options.length - 1;
    else choose(activeIndex.value);
    return;
  }
  if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    const index = props.options.findIndex((option) =>
      option.label.toLowerCase().startsWith(event.key.toLowerCase()),
    );
    if (index !== -1) activeIndex.value = index;
  }
}
function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close();
}
function focusout(event: FocusEvent) {
  if (!root.value?.contains(event.relatedTarget as Node)) close();
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);
onMounted(() => document.addEventListener("pointerdown", outside));
onBeforeUnmount(() => document.removeEventListener("pointerdown", outside));
</script>

<template>
  <div
    ref="root"
    class="ui-select relative text-[14px]"
    :class="[{ expanded, 'opens-above': opensAbove }, variant === 'time' ? 'w-full min-w-0' : 'min-w-40 mobile:min-w-[140px] mobile:text-[12px] narrow:min-w-[130px]']"
    @focusout="focusout"
  >
    <button
      :id="`${id}-trigger`"
      ref="trigger"
      type="button"
      class="
        ui-select-trigger flex w-full items-center justify-between rounded-sm border bg-canvas px-3 py-2.5
        text-left transition-[border-color] duration-160 ease-[ease] focus-visible:border-primary-active
        focus-visible:outline-none disabled:border-hairline disabled:bg-surface-soft disabled:text-muted
      "
      :class="[variant === 'time' ? 'min-h-12 gap-4 tabular-nums' : 'min-h-11 gap-4 mobile:gap-2', expanded ? 'border-primary-active not-disabled:hover:border-primary-active' : 'border-hairline not-disabled:hover:border-border-strong']"
      role="combobox"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="expanded"
      :aria-controls="expanded ? `${id}-list` : undefined"
      :disabled="disabled"
      @click="expanded ? close(true) : open()"
      @keydown.down.prevent="open()"
      @keydown.up.prevent="open()"
      @keydown.home.prevent="open('first')"
      @keydown.end.prevent="open('last')"
    >
      <span>{{ selected?.label || label }}</span>
      <ChevronDown class="transition-transform duration-160 ease-[ease]" :class="{ '[transform:rotate(180deg)]': expanded }" :size="16" aria-hidden="true" />
    </button>
    <ul
      v-if="expanded"
      :id="`${id}-list`"
      ref="list"
      class="
        ui-select-menu absolute right-0 z-30 m-0 w-max min-w-full max-w-[min(300px,calc(100vw-40px))] list-none
        rounded-md border border-hairline-soft bg-canvas p-2 shadow-[0_8px_28px_rgb(0_0_0_/_14%)]
        focus-visible:outline-none
      "
      :class="[opensAbove ? 'top-auto bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]', { 'max-h-60 overflow-y-auto': variant === 'time' }]"
      role="listbox"
      :aria-label="label"
      :aria-activedescendant="`${id}-option-${activeIndex}`"
      tabindex="-1"
      @keydown="keydown"
    >
      <li
        v-for="(option, index) in options"
        :id="`${id}-option-${index}`"
        :key="option.value"
        class="flex min-h-11 cursor-pointer items-center justify-between gap-6 rounded-sm p-3 leading-[1.43]"
        role="option"
        :aria-selected="option.value === modelValue"
        :class="{
          'highlighted bg-surface-soft': index === activeIndex,
          'selected text-primary-active font-semibold': option.value === modelValue,
        }"
        @pointermove="activeIndex = index"
        @mousedown.prevent
        @click="choose(index)"
      >
        <span>{{ option.label }}</span>
        <Check
          v-if="option.value === modelValue"
          :size="16"
          aria-hidden="true"
        />
      </li>
    </ul>
  </div>
</template>
