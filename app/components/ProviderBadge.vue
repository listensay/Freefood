<script setup lang="ts">
import type { BawangcanProvider } from "#shared/types";
import { providerShortNames } from "#shared/types";

defineProps<{ provider: BawangcanProvider }>();
</script>

<template>
  <span class="provider-badge inline-flex shrink-0 whitespace-nowrap rounded-none px-1.5 py-0.5 text-[11px] leading-[1.4]" :data-provider="provider" :class="provider === 'waimai' ? 'text-luxe bg-[color-mix(in_srgb,var(--color-luxe)_8%,var(--color-canvas))]' : 'text-primary-active bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--color-canvas))]'">{{ providerShortNames[provider] }}</span>
</template>
