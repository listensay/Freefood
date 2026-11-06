<script setup lang="ts">
import { X } from "@lucide/vue";
import { shanghaiDateTime, todayEnrollmentWindow } from "#shared/utils/enrollment-time";
const { scheduleDialog, scheduleOffer, scheduleTime, scheduleError, enrollingOfferIds, now, saveSchedule } = useFoodApp();
const bounds = computed(() => {
  const window = scheduleOffer.value && todayEnrollmentWindow(scheduleOffer.value, now.value);
  if (!window) return;
  const first = Math.ceil(window.start / 1000) * 1000, last = Math.ceil(window.end / 1000) * 1000 - 1000;
  if (first > last) return;
  return { min: shanghaiDateTime(new Date(first)), max: shanghaiDateTime(new Date(last)) };
});
</script>

<template>
  <dialog ref="scheduleDialog" class="location-dialog schedule-dialog" aria-label="预约报名"
    @click="$event.target === scheduleDialog && scheduleDialog?.close()">
    <form @submit.prevent="saveSchedule">
      <header class="dialog-header">
        <h2>预约报名</h2>
        <button type="button" class="icon-button" aria-label="关闭预约报名" @click="scheduleDialog?.close()"><X :size="21" /></button>
      </header>
      <p class="schedule-activity-name">{{ scheduleOffer?.name }}</p>
      <div class="schedule-time-heading"><span>报名时间</span><span>今天 · 北京时间</span></div>
      <UiTimePicker v-if="bounds" v-model="scheduleTime" :min="bounds.min" :max="bounds.max" @update:model-value="scheduleError = ''" />
      <p v-else class="inline-error">暂无可报名时段</p>
      <p v-if="scheduleError" class="inline-error" role="alert">{{ scheduleError }}</p>
      <button class="button primary full-width" :disabled="!bounds || (!!scheduleOffer && enrollingOfferIds.has(scheduleOffer.id))">确认预约</button>
    </form>
  </dialog>
</template>
