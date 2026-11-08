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
    for (const card of items) {
      card.style.gridColumn = "";
      card.style.gridRow = "";
    }
    const style = getComputedStyle(element);
    const columns = style.gridTemplateColumns.split(" ").length;
    if (columns === 1) {
      laidOut.value = false;
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
  <div ref="grid" class="store-grid" :class="{ 'flow-layout': laidOut }">
    <slot />
  </div>
</template>
