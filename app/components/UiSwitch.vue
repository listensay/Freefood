<script setup lang="ts">

import { Check } from "@lucide/vue";

defineProps<{ modelValue: boolean; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <label class="ui-switch" :class="{ disabled }">
    <input
      type="checkbox"
      role="switch"
      :checked="modelValue"
      :disabled="disabled"
      @change="
        emit('update:modelValue', ($event.target as HTMLInputElement).checked)
      "
    />
    <span class="ui-switch-track" aria-hidden="true">
      <span class="ui-switch-thumb"
        ><Check :size="12" :stroke-width="3"
      /></span>
    </span>
    <span><slot /></span>
  </label>
</template>
