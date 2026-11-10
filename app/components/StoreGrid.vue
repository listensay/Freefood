<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onUpdated } from "vue";
const grid = ref<HTMLDivElement>();
const laidOut = ref(false);
let observer: ResizeObserver | undefined;
let frame = 0;
let cards = new Set<HTMLElement>();

function scheduleLayout() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const element = grid.value;
    if (!element?.clientWidth) return;
    const items = Array.from(element.children) as HTMLElement[];
    // Keep the scroll range intact while card positions are cleared for measurement.
    element.style.minHeight = `${element.getBoundingClientRect().height}px`;
    for (const card of items) {
      card.style.gridColumn = "";
      card.style.gridRow = "";
    }
    const style = getComputedStyle(element);
    const columns = style.gridTemplateColumns.split(" ").length;
    if (columns === 1) {
      laidOut.value = false;
      element.style.minHeight = "";
      return;
    }
    const gap = Math.ceil(parseFloat(style.columnGap) || 0);
    const heights = Array<number>(columns).fill(0);
    const sizes = items.map(card => Math.ceil(card.getBoundingClientRect().height));
    items.forEach((card, index) => {
      const column = heights.indexOf(Math.min(...heights));
      card.style.gridColumn = String(column + 1);
      card.style.gridRow = `${heights[column]! + 1} / span ${Math.max(1, sizes[index]!)}`;
      heights[column]! += sizes[index]! + gap;
    });
    laidOut.value = true;
    element.style.minHeight = "";
  });
}

function observeCards() {
  const next = new Set(Array.from(grid.value?.children || []) as HTMLElement[]);
  for (const card of cards) if (!next.has(card)) observer?.unobserve(card);
  for (const card of next) if (!cards.has(card)) observer?.observe(card);
  cards = next;
  scheduleLayout();
}

onMounted(() => {
  observer = new ResizeObserver(scheduleLayout);
  observer.observe(grid.value!);
  observeCards();
});
onUpdated(observeCards);
onBeforeUnmount(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
</script>

<template>
  <div ref="grid" class="store-grid grid grid-cols-3 [align-items:start] gap-x-6 compact:grid-cols-2 mobile:grid-cols-1 mobile:gap-x-5" :class="laidOut ? 'flow-layout auto-rows-[1px] gap-y-0' : 'gap-y-6 mobile:gap-y-5'">
    <slot />
  </div>
</template>
