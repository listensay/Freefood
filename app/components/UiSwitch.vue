<script setup lang="ts">

import { Check } from "@lucide/vue";

defineProps<{ modelValue: boolean; disabled?: boolean; variant?: "default" | "card" }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <label class="ui-switch relative min-h-11 items-center leading-[1.5]"
    :class="[disabled ? 'disabled cursor-not-allowed text-muted' : 'cursor-pointer', variant === 'card'
      ? 'mb-4 min-w-0 flex flex-row-reverse justify-between gap-4 rounded-sm border border-hairline px-3 py-2 text-[14px]'
      : 'inline-flex gap-3 text-[14px] mobile:gap-2 mobile:text-[12px]']">
    <input
      class="peer absolute m-0 p-0 opacity-0 [border:0]"
      :class="variant === 'card' ? 'inset-0 size-full' : 'left-0 top-1.5 h-8 w-12'"
      type="checkbox"
      role="switch"
      :checked="modelValue"
      :disabled="disabled"
      @change="
        emit('update:modelValue', ($event.target as HTMLInputElement).checked)
      "
    />
    <span class="
      ui-switch-track pointer-events-none h-8 w-12 shrink-0 rounded-full p-[3px] transition-[background]
      duration-160 ease-[ease] peer-focus-visible:outline-2 peer-focus-visible:outline-solid
      peer-focus-visible:outline-primary-active peer-focus-visible:outline-offset-4 narrow:w-11
    " :class="disabled ? 'bg-hairline' : modelValue ? 'bg-primary' : 'bg-muted'" aria-hidden="true">
      <span class="
        ui-switch-thumb grid size-[26px] place-items-center rounded-full bg-canvas text-ink
        shadow-[0_1px_3px_rgb(0_0_0_/_15%)] transition-transform duration-160 ease-[ease]
      " :class="{ '[transform:translateX(16px)] narrow:[transform:translateX(12px)]': modelValue }"
        ><Check :class="modelValue ? 'visible' : 'invisible'" :size="12" :stroke-width="3"
      /></span>
    </span>
    <span><slot /></span>
  </label>
</template>
