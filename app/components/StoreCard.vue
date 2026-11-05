<script setup lang="ts">
import { Check, MapPin, Utensils } from "@lucide/vue";
import type { StoreMatchGroup } from "#shared/types";
import { providerNames, providerShortNames } from "#shared/types";
import { estimatePrice, money, priceOutcome, ruleLabel, reviewBonusLabel, suggestedPaidCents } from "#shared/utils/pricing";
const props = defineProps<{ group: StoreMatchGroup }>();
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
        <span class="match-status"
          ><Check :size="12" />{{
            match.confidence === "id"
              ? "已匹配"
              : "分店待核验"
          }}</span
        >
      </div>
    </div>
    <div v-for="{ match, paid, outcome } in variants" :key="match.id" class="activity-variant">
      <div class="rebate-lines">
        <div>
          <span class="provider-dot" :class="`${match.bawangcan.provider}-dot`"></span><span>{{ providerNames[match.bawangcan.provider] }}</span
          ><strong>{{ ruleLabel(match.bawangcan.rule) }}</strong>
        </div>
        <div>
          <span class="provider-dot meituan-dot"></span><span>美团试吃官</span
          ><strong>{{ ruleLabel(match.meituan.rule) }}</strong>
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
        }}</span
        ><span>{{
          match.bawangcan.inventory === undefined
            ? "名额待核验"
            : `${providerShortNames[match.bawangcan.provider]}剩 ${match.bawangcan.inventory} 份`
        }}</span
        ><span>{{
          match.meituan.inventory === undefined
            ? "名额待核验"
            : `美团剩 ${match.meituan.inventory} 份`
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
      </div>
    </div>
  </article>
</template>
