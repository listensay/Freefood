<script setup lang="ts">
import { ArrowRight, Check, Heart, MapPin, Utensils } from "@lucide/vue";
import type { StoreMatch } from "#shared/types";
import { calculatePrice, money, ruleLabel } from "#shared/utils/pricing";
const props = defineProps<{ match: StoreMatch; saved: boolean }>();
defineEmits<{ favorite: [id: string]; calculate: [match: StoreMatch] }>();
const paid = computed(() =>
  Math.max(
    props.match.xiaochan.rule.thresholdCents,
    props.match.meituan.rule.thresholdCents,
  ),
);
const result = computed(() =>
  calculatePrice({
    paidCents: paid.value,
    xiaochan: props.match.xiaochan,
    meituan: props.match.meituan,
  }),
);
const distance = computed(() => {
  const d =
    props.match.xiaochan.distanceMeters ?? props.match.meituan.distanceMeters;
  return d === undefined
    ? "距离未知"
    : d < 1000
      ? `${d} m`
      : `${(d / 1000).toFixed(1)} km`;
});
const imageFailed = ref(false);
</script>

<template>
  <article class="store-card">
    <div class="store-main">
      <div class="store-picture">
        <img
          v-if="!imageFailed && (match.xiaochan.image || match.meituan.image)"
          :src="match.xiaochan.image || match.meituan.image"
          :alt="match.xiaochan.category"
          loading="lazy"
          @error="imageFailed = true"
        /><Utensils v-else :size="26" />
      </div>
      <div class="store-info">
        <h3>{{ match.xiaochan.name }}</h3>
        <div class="store-meta">
          <span>{{ match.xiaochan.category }}</span
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
      <button
        class="favorite-button"
        :class="{ saved }"
        :aria-label="(saved ? '取消收藏 ' : '收藏 ') + match.xiaochan.name"
        :aria-pressed="saved"
        @click="$emit('favorite', match.id)"
      >
        <Heart :size="19" />
      </button>
    </div>
    <div class="rebate-lines">
      <div>
        <span class="provider-dot xiaochan-dot"></span><span>小蚕霸王餐</span
        ><strong>{{ ruleLabel(match.xiaochan.rule) }}</strong>
      </div>
      <div>
        <span class="provider-dot meituan-dot"></span><span>美团试吃官</span
        ><strong>{{ ruleLabel(match.meituan.rule) }}</strong>
      </div>
    </div>
    <div class="store-conditions">
      <span>{{
        match.xiaochan.requirement === "无需评价" &&
        match.meituan.requirement.startsWith("无需评价")
          ? "双方无需评价"
          : "含评价任务"
      }}</span
      ><span>{{
        match.xiaochan.inventory === undefined
          ? "名额待核验"
          : `小蚕剩 ${match.xiaochan.inventory} 份`
      }}</span
      ><span>{{
        match.meituan.inventory === undefined
          ? "名额待核验"
          : `美团剩 ${match.meituan.inventory} 份`
      }}</span>
    </div>
    <div class="card-bottom">
      <div class="net-price">
        <span
          >到手价（试算）
          <span class="price-assumption">· 实付 ¥{{ money(paid) }}</span></span
        ><strong
          ><small>¥</small>{{ money(result.theoreticalNetCents) }}</strong
        >
      </div>
      <button class="calculate-button" @click="$emit('calculate', match)">
        计算价格<ArrowRight :size="15" />
      </button>
    </div>
  </article>
</template>
