<script setup lang="ts">
import { computed } from "vue";
import RemoteImage from "./RemoteImage.vue";
import ProviderBadge from "./ProviderBadge.vue";
import { useFoodApp } from "../composables/useFoodApp";
import { Check, MapPin, Utensils } from "@lucide/vue";
import type { StoreMatchGroup } from "#shared/types";
import { providerNames } from "#shared/types";
import { activeAt, estimatePrice, money, priceOutcome, ruleLabel, reviewBonusLabel, suggestedPaidCents } from "#shared/utils/pricing";
import { todayEnrollmentWindow } from "#shared/utils/enrollment-time";
const props = defineProps<{ group: StoreMatchGroup }>();
const { busy, enrollingOfferIds, enrollmentActions, now, enroll, cancelEnrollment, openSchedule, cancelSchedule } = useFoodApp();
const scheduleTime = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const match = computed(() => props.group.matches[0]!);
const variants = computed(() => props.group.matches.map(match => {
  const paid = suggestedPaidCents(match.bawangcan);
  const result = estimatePrice({ paidCents: paid, bawangcan: match.bawangcan, meituan: match.meituan });
  return { match, paid, outcome: priceOutcome(result.balanceCents) };
}));
const distance = computed(() => {
  const d =
    match.value.bawangcan.distanceMeters ?? match.value.meituan.distanceMeters;
  return d === undefined
    ? "距离未知"
    : d < 1000
      ? `${d} m`
      : `${(d / 1000).toFixed(1)} km`;
});
</script>

<template>
  <article class="
    store-card flex min-w-0 flex-col rounded-md border border-hairline-soft bg-surface-card px-6 pt-6 pb-0
    shadow-[0_2px_8px_rgb(0_0_0_/_3%)] transition-[border-color,box-shadow] duration-160 ease-[ease]
    hover:shadow-[0_4px_16px_rgb(0_0_0_/_6%)] mobile:px-5 mobile:pt-5 narrow:px-4
  " :class="{ 'has-variants': variants.length > 1 }" :data-provider="match.bawangcan.provider">
    <div class="store-main relative flex items-center gap-[18px]">
      <div class="store-picture grid size-16 shrink-0 place-items-center overflow-hidden rounded-md bg-surface-soft text-muted">
        <RemoteImage
          :src="match.bawangcan.image"
          :fallback-src="match.meituan.image"
          :alt="match.bawangcan.category"
          loading="lazy"
        ><Utensils :size="26" /></RemoteImage>
      </div>
      <div class="store-info min-w-0 flex-1">
        <h3 class="text-[14px] font-semibold leading-[1.5] wrap-anywhere mobile:text-[16px]">{{ match.bawangcan.name }}</h3>
        <div class="store-meta mt-[5px] flex flex-wrap items-center gap-1 text-[12px] text-muted">
          <ProviderBadge v-if="match.bawangcan.provider !== 'meituan'" :provider="match.bawangcan.provider" />
          <span>{{ match.bawangcan.category }}</span
          ><span class="meta-divider mx-1 h-2.5 w-px bg-hairline"></span><MapPin :size="12" />{{ distance }}
        </div>
        <span v-if="match.confidence === 'id'" class="match-status mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted mobile:text-[12px]"><Check :size="12" />已匹配</span>
      </div>
    </div>
    <div v-for="{ match, paid, outcome } in variants" :key="match.id" class="activity-variant flex flex-1 flex-col [&+.activity-variant]:border-t [&+.activity-variant]:border-t-hairline-soft">
      <div class="rebate-lines mt-8 grid gap-5">
        <div class="flex items-baseline gap-[7px] text-[12px] text-muted mobile:text-[13px]">
          <span class="rebate-provider grid shrink-0 gap-1.5">
            <span class="rebate-provider-name inline-flex items-center gap-[7px]"><span class="provider-dot inline-block size-1.5 shrink-0 self-center rounded-full" :class="[`${match.bawangcan.provider}-dot`, match.bawangcan.provider === 'xiaochan' ? 'bg-primary' : match.bawangcan.provider === 'waimai' ? 'bg-muted' : 'bg-ink']"></span>{{ providerNames[match.bawangcan.provider] }}</span>
            <span class="rebate-inventory pl-[13px] text-[11px]">{{ match.bawangcan.inventory === undefined ? '名额待核验' : `剩 ${match.bawangcan.inventory} 份` }}</span>
          </span>
          <strong class="ml-auto text-right text-[12px] font-medium text-ink mobile:text-[13px]">{{ ruleLabel(match.bawangcan.rule) }}</strong>
        </div>
        <div class="flex items-baseline gap-[7px] text-[12px] text-muted mobile:text-[13px]">
          <span class="rebate-provider grid shrink-0 gap-1.5">
            <span class="rebate-provider-name inline-flex items-center gap-[7px]"><span class="provider-dot meituan-dot inline-block size-1.5 shrink-0 self-center rounded-full bg-ink"></span>美团试吃官</span>
            <span class="rebate-inventory pl-[13px] text-[11px]">{{ match.meituan.inventory === undefined ? '名额待核验' : `剩 ${match.meituan.inventory} 份` }}</span>
          </span>
          <strong class="ml-auto text-right text-[12px] font-medium text-ink mobile:text-[13px]">{{ ruleLabel(match.meituan.rule) }}</strong>
        </div>
        <div v-if="match.meituan.reviewBonus" class="flex items-baseline gap-[7px] text-[12px] text-muted mobile:text-[13px]">
          <span class="provider-dot meituan-dot inline-block size-1.5 shrink-0 self-center rounded-full bg-ink"></span><span>美团评价</span>
          <strong class="ml-auto text-right text-[12px] font-medium text-ink mobile:text-[13px]">{{ reviewBonusLabel(match.meituan.reviewBonus) }}</strong>
        </div>
      </div>
      <div class="store-conditions my-6 grid gap-2 text-[11px] text-muted mobile:text-[12px]">
        <span v-if="match.bawangcan.product">{{ match.bawangcan.product.name }}</span>
        <span>{{
          match.bawangcan.requirement === "无需评价" &&
          match.meituan.requirement.startsWith("无需评价") && !match.meituan.reviewBonus
            ? "双方无需评价"
            : "含评价任务"
        }}</span>
      </div>
      <div class="
        card-bottom mt-auto flex items-end justify-between gap-4 border-t border-t-hairline-soft pt-5 pb-6
        has-[.enrollment-actions]:flex-wrap has-[.enrollment-actions]:gap-y-3
      ">
        <div class="net-price">
          <span class="block text-[12px] text-muted">
            <span class="price-outcome inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 font-medium leading-[1.5]" :data-kind="outcome.kind" :class="outcome.kind === 'income' ? 'text-primary-active bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--color-canvas))]' : outcome.kind === 'expense' ? 'text-on-primary bg-ink' : 'text-muted bg-surface-strong'">{{ outcome.label }}</span>
            <span class="price-assumption ms-2 mobile:text-[11px]" :class="variants.length > 1 ? 'inline' : 'hidden mobile:inline narrow:hidden'">· 订单 ¥{{ money(paid) }}</span>
          </span><strong class="mt-[18px] flex items-baseline gap-[3px] text-[28px] font-semibold leading-[1.3] text-primary-active tabular-nums"
            ><small class="text-[16px] font-medium">¥</small>{{ money(outcome.amountCents) }}</strong
          >
        </div>
        <div v-if="(match.bawangcan.provider === 'xiaochan' || (match.bawangcan.provider === 'waimai' && match.bawangcan.enrollmentAvailable === true)) && match.bawangcan.source === 'live'" class="enrollment-actions ml-auto flex shrink-0 items-center gap-2">
        <button
          class="
            button primary enrollment-button inline-flex items-center justify-center gap-2 border font-semibold
            leading-[1.25] whitespace-nowrap no-underline transition-[background,border-color] duration-160
            ease-[ease] min-h-9 rounded-sm px-4 py-2 text-[14px] bg-primary border-primary text-on-primary
            not-disabled:hover:bg-primary-active not-disabled:hover:border-primary-active
            not-disabled:active:bg-primary-active not-disabled:active:border-primary-active
            disabled:bg-primary-disabled disabled:border-primary-disabled disabled:text-on-primary
          "
          :disabled="(!!busy && busy !== 'enroll') || enrollingOfferIds.has(match.bawangcan.id) || match.bawangcan.enrollment?.state === 'enrolled' || (match.bawangcan.enrollmentSchedule && match.bawangcan.enrollmentSchedule.state !== 'failed') || (!match.bawangcan.enrollment && !activeAt(match.bawangcan, now))"
          :aria-busy="enrollingOfferIds.has(match.bawangcan.id)"
          @click="match.bawangcan.enrollment?.state === 'cancel-unknown' ? cancelEnrollment(match.bawangcan) : enroll(match.bawangcan)"
        >{{ match.bawangcan.enrollment?.state === 'enrolled' ? '已报名'
          : enrollingOfferIds.has(match.bawangcan.id) ? (enrollmentActions[match.bawangcan.id] === 'cancel' ? '查询中…' : match.bawangcan.enrollment?.state === 'unknown' ? '查询中…' : '报名中…')
            : match.bawangcan.enrollmentSchedule?.state === 'running' ? '报名中…'
            : match.bawangcan.enrollment?.state === 'cancel-unknown' ? '查看取消'
              : match.bawangcan.enrollment?.state === 'unknown' ? '查看报名'
                : match.bawangcan.enrollmentSchedule?.state === 'scheduled' ? `${scheduleTime(match.bawangcan.enrollmentSchedule.runAt)} 报名` : '报名' }}</button>
        <button v-if="match.bawangcan.enrollment?.state === 'enrolled' || (match.bawangcan.provider === 'waimai' && match.bawangcan.enrollment?.state === 'unknown' && match.bawangcan.enrollment.orderId)" class="
          button secondary enrollment-action-button cancel-enrollment-button inline-flex items-center
          justify-center gap-2 border font-semibold leading-[1.25] whitespace-nowrap no-underline
          transition-[background,border-color] duration-160 ease-[ease] min-h-9 rounded-sm px-4 py-2 text-[14px]
          bg-canvas border-hairline text-ink not-disabled:hover:bg-surface-soft
          not-disabled:hover:border-border-strong not-disabled:active:bg-surface-soft
          not-disabled:active:border-border-strong disabled:border-hairline disabled:text-muted
        "
          :disabled="(!!busy && busy !== 'enroll') || enrollingOfferIds.has(match.bawangcan.id)"
          @click="cancelEnrollment(match.bawangcan)"
        >{{ enrollmentActions[match.bawangcan.id] === 'cancel' ? '取消中…' : '取消报名' }}</button>
        <button v-else-if="match.bawangcan.enrollmentSchedule && match.bawangcan.enrollmentSchedule.state !== 'failed'" class="
          button secondary enrollment-action-button inline-flex items-center justify-center gap-2 border
          font-semibold leading-[1.25] whitespace-nowrap no-underline transition-[background,border-color]
          duration-160 ease-[ease] min-h-9 rounded-sm px-4 py-2 text-[14px] bg-canvas border-hairline text-ink
          not-disabled:hover:bg-surface-soft not-disabled:hover:border-border-strong
          not-disabled:active:bg-surface-soft not-disabled:active:border-border-strong disabled:border-hairline
          disabled:text-muted
        "
          :disabled="(!!busy && busy !== 'enroll') || enrollingOfferIds.has(match.bawangcan.id) || match.bawangcan.enrollmentSchedule.state === 'running'"
          @click="cancelSchedule(match.bawangcan.id)"
        >取消预约</button>
        <button v-else-if="!match.bawangcan.enrollment" class="
          button secondary enrollment-action-button schedule-enrollment-button inline-flex items-center
          justify-center gap-2 border font-semibold leading-[1.25] whitespace-nowrap no-underline
          transition-[background,border-color] duration-160 ease-[ease] min-h-9 rounded-sm px-4 py-2 text-[14px]
          bg-canvas border-hairline disabled:text-muted
          not-disabled:bg-[color-mix(in_srgb,var(--color-luxe)_6%,var(--color-canvas))]
          not-disabled:border-[color-mix(in_srgb,var(--color-luxe)_24%,var(--color-canvas))]
          not-disabled:text-luxe
          not-disabled:hover:bg-[color-mix(in_srgb,var(--color-luxe)_10%,var(--color-canvas))]
          not-disabled:hover:border-[color-mix(in_srgb,var(--color-luxe)_40%,var(--color-canvas))]
          not-disabled:active:bg-[color-mix(in_srgb,var(--color-luxe)_10%,var(--color-canvas))]
          not-disabled:active:border-[color-mix(in_srgb,var(--color-luxe)_40%,var(--color-canvas))]
        "
          :disabled="(!!busy && busy !== 'enroll') || enrollingOfferIds.has(match.bawangcan.id) || !todayEnrollmentWindow(match.bawangcan, now)"
          @click="openSchedule(match.bawangcan)"
        >预约报名</button>
        </div>
      </div>
    </div>
  </article>
</template>
