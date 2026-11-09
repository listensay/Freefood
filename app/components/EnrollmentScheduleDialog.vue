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
  <dialog ref="scheduleDialog" class="
    location-dialog schedule-dialog w-[480px] max-w-[calc(100vw-32px)] max-h-[calc(100dvh-48px)] rounded-lg p-8
    mobile:max-h-[calc(100dvh-32px)] mobile:p-6 overflow-visible
  " aria-label="预约报名"
    @click="$event.target === scheduleDialog && scheduleDialog?.close()">
    <form @submit.prevent="saveSchedule">
      <header class="dialog-header mb-6 flex items-center justify-between gap-4">
        <h2 class="text-[22px] leading-[1.2] mobile:text-[20px]">预约报名</h2>
        <button type="button" class="icon-button grid size-8 place-items-center rounded-full p-0 text-ink hover:bg-surface-strong" aria-label="关闭预约报名" @click="scheduleDialog?.close()"><X :size="21" /></button>
      </header>
      <p class="schedule-activity-name mb-4">{{ scheduleOffer?.name }}</p>
      <UiSwitch v-if="scheduleLoading || scheduleAdvanceAvailable" class="schedule-coupon-option" variant="card"
        :model-value="scheduleUseAdvance" :disabled="scheduleLoading || (!!scheduleOffer && enrollingOfferIds.has(scheduleOffer.id))"
        @update:model-value="setScheduleUseAdvance">
        <span class="schedule-coupon-text grid gap-0.5">
          <span>使用超前抢单券</span>
          <span class="schedule-coupon-time text-[12px] text-muted tabular-nums">{{ scheduleLoading ? '查询卡券…' : `最早 ${earliestAdvanceTime}` }}</span>
        </span>
      </UiSwitch>
      <div class="schedule-time-heading flex justify-between gap-3 text-[14px]"><span>报名时间</span><span class="text-[12px] text-muted">今天 · 北京时间</span></div>
      <UiTimePicker v-if="bounds" v-model="scheduleTime" :min="bounds.min" :max="bounds.max" :windows="windows" @update:model-value="scheduleError = ''" />
      <p v-else-if="!scheduleLoading" class="inline-error mt-4 mb-0 text-[14px] text-primary-error-text">暂无可报名时段</p>
      <p v-if="scheduleOptionsError && !scheduleError" class="inline-error mt-4 mb-0 text-[14px] text-primary-error-text" role="alert">{{ scheduleOptionsError }}</p>
      <p v-if="scheduleError" class="inline-error mt-4 mb-0 text-[14px] text-primary-error-text" role="alert">{{ scheduleError }}</p>
      <button class="
        mt-6 button primary full-width inline-flex items-center justify-center gap-2 border font-semibold
        leading-[1.25] whitespace-nowrap no-underline transition-[background,border-color] duration-160
        ease-[ease] min-h-12 rounded-sm px-[23px] py-[13px] text-[16px] bg-primary border-primary
        text-on-primary not-disabled:hover:bg-primary-active not-disabled:hover:border-primary-active
        not-disabled:active:bg-primary-active not-disabled:active:border-primary-active
        disabled:bg-primary-disabled disabled:border-primary-disabled disabled:text-on-primary w-full
      " :disabled="scheduleLoading || !bounds || (!!scheduleOffer && enrollingOfferIds.has(scheduleOffer.id))">确认预约</button>
    </form>
  </dialog>
</template>
