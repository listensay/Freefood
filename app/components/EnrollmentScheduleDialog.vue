<script setup lang="ts">
import { computed } from "vue";
import { useFoodApp } from "../composables/useFoodApp";
import UiTimePicker from "./UiTimePicker.vue";
import UiSwitch from "./UiSwitch.vue";
import { X } from "@lucide/vue";
import { shanghaiDateTime } from "#shared/utils/enrollment-time";
const { scheduleDialog, scheduleOffer, scheduleTime, scheduleError, enrollingOfferIds, saveSchedule,
  scheduleLoading, scheduleOptionsError, scheduleWindows, scheduleUseAdvance, scheduleAdvanceAvailable,
  scheduleCouponWindows, setScheduleUseAdvance } = useFoodApp();
const windows = computed(() => scheduleWindows.value.flatMap(window => {
  const first = Math.ceil(window.start / 1000) * 1000, last = Math.ceil(window.end / 1000) * 1000 - 1000;
  return first > last ? [] : [{ min: shanghaiDateTime(new Date(first)), max: shanghaiDateTime(new Date(last)) }];
}));
const bounds = computed(() => windows.value.length ? { min: windows.value[0]!.min, max: windows.value.at(-1)!.max } : undefined);
const earliestAdvanceTime = computed(() => {
  const first = scheduleCouponWindows.value[0];
  if (!first) return "";
  const value = shanghaiDateTime(new Date(Math.ceil(first.start / 1000) * 1000)).slice(11);
  return value.endsWith(":00") ? value.slice(0, 5) : value;
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
      <UiSwitch v-if="scheduleLoading || scheduleAdvanceAvailable" class="schedule-coupon-option"
        :model-value="scheduleUseAdvance" :disabled="scheduleLoading || (!!scheduleOffer && enrollingOfferIds.has(scheduleOffer.id))"
        @update:model-value="setScheduleUseAdvance">
        <span class="schedule-coupon-text">
          <span>使用超前抢单券</span>
          <span class="schedule-coupon-time">{{ scheduleLoading ? '查询卡券…' : `最早 ${earliestAdvanceTime}` }}</span>
        </span>
      </UiSwitch>
      <div class="schedule-time-heading"><span>报名时间</span><span>今天 · 北京时间</span></div>
      <UiTimePicker v-if="bounds" v-model="scheduleTime" :min="bounds.min" :max="bounds.max" :windows="windows" @update:model-value="scheduleError = ''" />
      <p v-else-if="!scheduleLoading" class="inline-error">暂无可报名时段</p>
      <p v-if="scheduleOptionsError && !scheduleError" class="inline-error" role="alert">{{ scheduleOptionsError }}</p>
      <p v-if="scheduleError" class="inline-error" role="alert">{{ scheduleError }}</p>
      <button class="button primary full-width" :disabled="scheduleLoading || !bounds || (!!scheduleOffer && enrollingOfferIds.has(scheduleOffer.id))">确认预约</button>
    </form>
  </dialog>
</template>
