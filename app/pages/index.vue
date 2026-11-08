<script setup lang="ts">
import { computed } from "vue";
import { useFoodApp } from "../composables/useFoodApp";
import StoreCard from "../components/StoreCard.vue";
import StoreGrid from "../components/StoreGrid.vue";
import UiSelect from "../components/UiSelect.vue";
import { RefreshCw, Search, SlidersHorizontal } from "@lucide/vue";
import type { StoreMatch } from "#shared/types";
import { groupStoreMatches, matchStores } from "#shared/utils/matching";
import { estimatePrice, suggestedPaidCents } from "#shared/utils/pricing";
import { COMPARISON_RADIUS_METERS, matchWithinRadius } from "#shared/utils/scope";

const { loaded, data, busy, enrollingOfferIds, syncing, filter, sort, bawangcanProvider, sync, changeCombination, cancelSchedule } = useFoodApp();
const scheduledTime = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

const matches = computed(() =>
  matchStores(
    data.value.offers[bawangcanProvider.value],
    data.value.offers.meituan,
  ).filter(match =>
    matchWithinRadius(match, COMPARISON_RADIUS_METERS) &&
    (match.bawangcan.inventory ?? 0) > 0 &&
    (match.meituan.inventory ?? 0) > 0,
  ),
);
const preview = (m: StoreMatch) =>
  estimatePrice({
    paidCents: suggestedPaidCents(m.bawangcan),
    bawangcan: m.bawangcan,
    meituan: m.meituan,
  });
const visibleMatches = computed(() => {
  let rows = [...matches.value];
  if (filter.value === "low")
    rows = rows.filter((m) => preview(m).theoreticalNetCents <= 500);
  if (filter.value === "no-review")
    rows = rows.filter(
      (m) =>
        m.bawangcan.requirement.startsWith("无需评价") &&
        m.meituan.requirement.startsWith("无需评价") && !m.meituan.reviewBonus,
    );
  return rows.sort((a, b) =>
    sort.value === "distance"
      ? (a.bawangcan.distanceMeters ?? Infinity) -
        (b.bawangcan.distanceMeters ?? Infinity)
      : sort.value === "rebate"
        ? preview(b).totalRebateCents - preview(a).totalRebateCents
        : preview(a).theoreticalNetCents - preview(b).theoreticalNetCents,
  );
});
const visibleGroups = computed(() =>
  groupStoreMatches(visibleMatches.value),
);
const lastUpdated = computed(() => {
  const dates = [
    data.value.updatedAt[bawangcanProvider.value],
    data.value.updatedAt.meituan,
  ].filter(Boolean).sort();
  return dates.length
      ? `最近同步 ${new Date(dates.at(-1)!).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })}`
      : "尚未同步活动";
});
const sortOptions = [
  { value: "price", label: "支出升序" },
  { value: "rebate", label: "返现降序" },
  { value: "distance", label: "距离升序" },
];
</script>

<template>
  <div>
    <section class="page-heading">
      <button
        class="button primary sync-button"
        :disabled="!!busy || syncing || !loaded"
        @click="sync()"
      >
        <RefreshCw :size="16" :class="{ spinning: syncing }" />{{
          syncing ? "正在同步…" : "同步活动"
        }}
      </button>
    </section>
    <section v-if="data.enrollmentSchedules?.length" class="scheduled-enrollments" aria-label="预约报名任务">
      <div v-for="schedule in data.enrollmentSchedules" :key="schedule.offerId" class="scheduled-enrollment">
        <span>{{ schedule.name }}</span>
        <time :datetime="schedule.runAt">{{ scheduledTime(schedule.runAt) }}</time>
        <span v-if="schedule.state === 'running'">报名中…</span>
        <span v-else-if="schedule.state === 'failed'" class="schedule-failed">{{ schedule.message || '预约报名失败' }}</span>
        <button class="text-button" :disabled="schedule.state === 'running' || enrollingOfferIds.has(schedule.offerId) || (!!busy && busy !== 'enroll')" @click="cancelSchedule(schedule.offerId)">{{ schedule.state === 'failed' ? '移除' : '取消预约' }}</button>
      </div>
    </section>
    <div class="combination-tabs filter-tabs" aria-label="选择叠加组合">
      <button
        :class="{ selected: bawangcanProvider === 'xiaochan' }"
        :aria-pressed="bawangcanProvider === 'xiaochan'"
        @click="changeCombination('xiaochan')"
      ><span class="platform-logo xiaochan-logo" aria-hidden="true">蚕</span>小蚕</button>
      <button
        :class="{ selected: bawangcanProvider === 'waimai' }"
        :aria-pressed="bawangcanProvider === 'waimai'"
        @click="changeCombination('waimai')"
      ><span class="platform-logo waimai-logo" aria-hidden="true">歪</span>歪麦</button>
    </div>
    <section class="results-section" aria-label="同店匹配结果">
      <div class="results-title">
        <h2>
          7 公里内匹配活动<span>{{ visibleGroups.length }}</span>
        </h2>
        <div>
          <span class="updated-at">{{ lastUpdated }}</span>
        </div>
      </div>
      <div class="filter-toolbar">
        <div class="filter-tabs" aria-label="筛选活动">
          <button
            :class="{ selected: filter === 'all' }"
            :aria-pressed="filter === 'all'"
            @click="filter = 'all'"
          >
            全部</button
          ><button
            :class="{ selected: filter === 'low' }"
            :aria-pressed="filter === 'low'"
            @click="filter = 'low'"
          >
            支出 ≤ ¥5</button
          ><button
            :class="{ selected: filter === 'no-review' }"
            :aria-pressed="filter === 'no-review'"
            @click="filter = 'no-review'"
          >
            双方无需评价
          </button>
        </div>
        <div class="secondary-filters">
          <div class="sort-control">
            <SlidersHorizontal :size="16" />
            <UiSelect
              v-model="sort"
              :options="sortOptions"
              label="结果排序"
            />
          </div>
        </div>
      </div>
      <StoreGrid v-if="visibleGroups.length">
        <StoreCard
          v-for="group in visibleGroups"
          :key="group.id"
          :group="group"
        />
      </StoreGrid>
      <div v-else class="empty-state">
        <span><Search :size="30" /></span>
        <h3>
          {{
            matches.length ? "暂无筛选结果" : "暂无匹配活动"
          }}
        </h3>
      </div>
    </section>
  </div>
</template>
