<script setup lang="ts">
import { Check, MapPin, Utensils } from "@lucide/vue";
import type { StoreMatchGroup } from "#shared/types";
import { providerNames } from "#shared/types";
import { activeAt, estimatePrice, money, priceOutcome, ruleLabel, reviewBonusLabel, suggestedPaidCents } from "#shared/utils/pricing";
import { todayEnrollmentWindow } from "#shared/utils/enrollment-time";
const props = defineProps<{ group: StoreMatchGroup }>();
const { busy, enrollingOfferIds, enrollmentActions, now, enrollXiaochan, cancelEnrollment, openSchedule, cancelSchedule } = useFoodApp();
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
const imageFailed = ref(false);
</script>

<template>
  <article class="store-card" :class="{ 'has-variants': variants.length > 1 }">
    <div class="store-main">
      <div class="store-picture">
        <img
          v-if="!imageFailed && (match.bawangcan.image || match.meituan.image)"
          :src="match.bawangcan.image || match.meituan.image"
          :alt="match.bawangcan.category"
          loading="lazy"
          @error="imageFailed = true"
        /><Utensils v-else :size="26" />
      </div>
      <div class="store-info">
        <h3>{{ match.bawangcan.name }}</h3>
        <div class="store-meta">
          <span>{{ match.bawangcan.category }}</span
          ><span class="meta-divider"></span><MapPin :size="12" />{{ distance }}
        </div>
        <span v-if="match.confidence === 'id'" class="match-status"><Check :size="12" />已匹配</span>
      </div>
    </div>
    <div v-for="{ match, paid, outcome } in variants" :key="match.id" class="activity-variant">
      <div class="rebate-lines">
        <div>
          <span class="rebate-provider">
            <span class="rebate-provider-name"><span class="provider-dot" :class="`${match.bawangcan.provider}-dot`"></span>{{ providerNames[match.bawangcan.provider] }}</span>
            <span class="rebate-inventory">{{ match.bawangcan.inventory === undefined ? '名额待核验' : `剩 ${match.bawangcan.inventory} 份` }}</span>
          </span>
          <strong>{{ ruleLabel(match.bawangcan.rule) }}</strong>
        </div>
        <div>
          <span class="rebate-provider">
            <span class="rebate-provider-name"><span class="provider-dot meituan-dot"></span>美团试吃官</span>
            <span class="rebate-inventory">{{ match.meituan.inventory === undefined ? '名额待核验' : `剩 ${match.meituan.inventory} 份` }}</span>
          </span>
          <strong>{{ ruleLabel(match.meituan.rule) }}</strong>
        </div>
        <div v-if="match.meituan.reviewBonus">
          <span class="provider-dot meituan-dot"></span><span>美团评价</span>
          <strong>{{ reviewBonusLabel(match.meituan.reviewBonus) }}</strong>
        </div>
      </div>
      <div class="store-conditions">
        <span v-if="match.bawangcan.product">{{ match.bawangcan.product.name }}</span>
        <span>{{
          match.bawangcan.requirement === "无需评价" &&
          match.meituan.requirement.startsWith("无需评价") && !match.meituan.reviewBonus
            ? "双方无需评价"
            : "含评价任务"
        }}</span>
      </div>
      <div class="card-bottom">
        <div class="net-price">
          <span>
            <span class="price-outcome" :data-kind="outcome.kind">{{ outcome.label }}</span>
            <span class="price-assumption">· 订单 ¥{{ money(paid) }}</span>
          </span><strong
            ><small>¥</small>{{ money(outcome.amountCents) }}</strong
          >
        </div>
        <div v-if="match.bawangcan.provider === 'xiaochan' && match.bawangcan.source === 'live'" class="enrollment-actions">
        <button
          class="button primary enrollment-button"
          :disabled="(!!busy && busy !== 'enroll') || enrollingOfferIds.has(match.bawangcan.id) || match.bawangcan.enrollment?.state === 'enrolled' || (match.bawangcan.enrollmentSchedule && match.bawangcan.enrollmentSchedule.state !== 'failed') || (!match.bawangcan.enrollment && !activeAt(match.bawangcan, now))"
          :aria-busy="enrollingOfferIds.has(match.bawangcan.id)"
          @click="match.bawangcan.enrollment?.state === 'cancel-unknown' ? cancelEnrollment(match.bawangcan) : enrollXiaochan(match.bawangcan)"
        >{{ match.bawangcan.enrollment?.state === 'enrolled' ? '已报名'
          : enrollingOfferIds.has(match.bawangcan.id) ? (enrollmentActions[match.bawangcan.id] === 'cancel' ? '查询中…' : match.bawangcan.enrollment?.state === 'unknown' ? '查询中…' : '报名中…')
            : match.bawangcan.enrollmentSchedule?.state === 'running' ? '报名中…'
            : match.bawangcan.enrollment?.state === 'cancel-unknown' ? '查看取消'
              : match.bawangcan.enrollment?.state === 'unknown' ? '查看报名'
                : match.bawangcan.enrollmentSchedule?.state === 'scheduled' ? `${scheduleTime(match.bawangcan.enrollmentSchedule.runAt)} 报名` : '报名' }}</button>
        <button v-if="match.bawangcan.enrollment?.state === 'enrolled'" class="button secondary enrollment-action-button cancel-enrollment-button"
          :disabled="(!!busy && busy !== 'enroll') || enrollingOfferIds.has(match.bawangcan.id)"
          @click="cancelEnrollment(match.bawangcan)"
        >{{ enrollmentActions[match.bawangcan.id] === 'cancel' ? '取消中…' : '取消报名' }}</button>
        <button v-else-if="match.bawangcan.enrollmentSchedule && match.bawangcan.enrollmentSchedule.state !== 'failed'" class="button secondary enrollment-action-button"
          :disabled="(!!busy && busy !== 'enroll') || enrollingOfferIds.has(match.bawangcan.id) || match.bawangcan.enrollmentSchedule.state === 'running'"
          @click="cancelSchedule(match.bawangcan.id)"
        >取消预约</button>
        <button v-else-if="!match.bawangcan.enrollment" class="button secondary enrollment-action-button schedule-enrollment-button"
          :disabled="(!!busy && busy !== 'enroll') || enrollingOfferIds.has(match.bawangcan.id) || !todayEnrollmentWindow(match.bawangcan, now)"
          @click="openSchedule(match.bawangcan)"
        >预约报名</button>
        </div>
      </div>
    </div>
  </article>
</template>
