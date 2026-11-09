<script setup lang="ts">
import { computed } from "vue";
import { useFoodApp } from "../composables/useFoodApp";
import StoreCard from "../components/StoreCard.vue";
import StoreGrid from "../components/StoreGrid.vue";
import ProviderBadge from "../components/ProviderBadge.vue";
import UiSelect from "../components/UiSelect.vue";
import { RefreshCw, Search, SlidersHorizontal } from "@lucide/vue";
import type { StoreMatch } from "#shared/types";
import { groupStoreMatches, matchStores } from "#shared/utils/matching";
import { estimatePrice, suggestedPaidCents } from "#shared/utils/pricing";
import { COMPARISON_RADIUS_METERS, matchWithinRadius } from "#shared/utils/scope";

const { loaded, data, busy, enrollingOfferIds, syncing, filter, sort, sync, cancelSchedule } = useFoodApp();
const scheduledTime = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

const matches = computed(() =>
  matchStores(
    [...data.value.offers.xiaochan, ...data.value.offers.waimai],
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
    data.value.updatedAt.xiaochan,
    data.value.updatedAt.waimai,
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
    <section class="page-heading mb-8 flex items-center justify-between gap-6 mobile:mb-6 mobile:gap-3">
      <button
        class="
          button primary sync-button inline-flex items-center justify-center gap-2 border font-semibold
          leading-[1.25] whitespace-nowrap no-underline transition-[background,border-color] duration-160
          ease-[ease] min-h-12 rounded-full px-[23px] py-[13px] text-[14px] mobile:min-h-11 mobile:px-4
          mobile:text-[13px] bg-primary border-primary text-on-primary not-disabled:hover:bg-primary-active
          not-disabled:hover:border-primary-active not-disabled:active:bg-primary-active
          not-disabled:active:border-primary-active disabled:bg-primary-disabled
          disabled:border-primary-disabled disabled:text-on-primary
        "
        :disabled="!!busy || syncing || !loaded"
        @click="sync()"
      >
        <RefreshCw :size="16" :class="{ 'spinning animate-spin [animation-duration:1.2s]': syncing }" />{{
          syncing ? "正在同步…" : "同步活动"
        }}
      </button>
    </section>
    <section v-if="data.enrollmentSchedules?.length" class="scheduled-enrollments mb-6 rounded-sm border border-hairline-soft bg-canvas" aria-label="预约报名任务">
      <div v-for="schedule in data.enrollmentSchedules" :key="schedule.offerId" class="scheduled-enrollment flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-[13px]">
        <span class="scheduled-enrollment-name flex min-w-[120px] flex-1 items-center gap-2 wrap-anywhere"><ProviderBadge :provider="schedule.offerId.startsWith('waimai:') ? 'waimai' : 'xiaochan'" />{{ schedule.name }}</span>
        <time class="text-muted" :datetime="schedule.runAt">{{ scheduledTime(schedule.runAt) }}</time>
        <span v-if="schedule.state === 'running'">报名中…</span>
        <span v-else-if="schedule.state === 'failed'" class="schedule-failed text-primary-error-text">{{ schedule.message || '预约报名失败' }}</span>
        <button class="
          text-button inline-flex min-h-10 items-center justify-center gap-1.5 rounded-sm p-2 text-[13px]
          text-ink whitespace-nowrap not-disabled:hover:bg-surface-soft disabled:text-muted disabled:opacity-50
        " :disabled="schedule.state === 'running' || enrollingOfferIds.has(schedule.offerId) || (!!busy && busy !== 'enroll')" @click="cancelSchedule(schedule.offerId)">{{ schedule.state === 'failed' ? '移除' : '取消预约' }}</button>
      </div>
    </section>
    <section class="results-section" aria-label="同店匹配结果">
      <div class="results-title mb-4 flex items-center justify-between gap-4 mobile:mb-2 mobile:gap-2">
        <h2 class="flex flex-wrap items-center gap-3 mobile:gap-2 mobile:text-[18px]">
          7 公里内匹配活动<span class="text-[16px] font-normal tracking-normal text-muted tabular-nums mobile:text-[14px]">{{ visibleGroups.length }}</span>
        </h2>
        <div class="flex items-center gap-4">
          <span class="updated-at whitespace-nowrap text-[12px] text-muted tablet:hidden">{{ lastUpdated }}</span>
        </div>
      </div>
      <div class="filter-toolbar mb-6 flex items-center justify-between gap-6 border-b border-b-hairline-soft tablet:flex-wrap tablet:gap-0">
        <div class="filter-tabs flex gap-8 mobile:gap-6 narrow:gap-[18px]" aria-label="筛选活动">
          <button
            class="
              relative whitespace-nowrap px-0 py-4 text-[14px] leading-[1.43] text-muted hover:text-ink
              aria-pressed:font-semibold aria-pressed:text-primary-active aria-pressed:after:absolute
              aria-pressed:after:inset-x-0 aria-pressed:after:-bottom-px aria-pressed:after:h-0.5
              aria-pressed:after:bg-primary aria-pressed:after:content-[''] mobile:py-3.5 mobile:text-[13px]
              narrow:text-[12px]
            "
            :class="{ selected: filter === 'all' }"
            :aria-pressed="filter === 'all'"
            @click="filter = 'all'"
          >
            全部</button
          ><button
            class="
              relative whitespace-nowrap px-0 py-4 text-[14px] leading-[1.43] text-muted hover:text-ink
              aria-pressed:font-semibold aria-pressed:text-primary-active aria-pressed:after:absolute
              aria-pressed:after:inset-x-0 aria-pressed:after:-bottom-px aria-pressed:after:h-0.5
              aria-pressed:after:bg-primary aria-pressed:after:content-[''] mobile:py-3.5 mobile:text-[13px]
              narrow:text-[12px]
            "
            :class="{ selected: filter === 'low' }"
            :aria-pressed="filter === 'low'"
            @click="filter = 'low'"
          >
            支出 ≤ ¥5</button
          ><button
            class="
              relative whitespace-nowrap px-0 py-4 text-[14px] leading-[1.43] text-muted hover:text-ink
              aria-pressed:font-semibold aria-pressed:text-primary-active aria-pressed:after:absolute
              aria-pressed:after:inset-x-0 aria-pressed:after:-bottom-px aria-pressed:after:h-0.5
              aria-pressed:after:bg-primary aria-pressed:after:content-[''] mobile:py-3.5 mobile:text-[13px]
              narrow:text-[12px]
            "
            :class="{ selected: filter === 'no-review' }"
            :aria-pressed="filter === 'no-review'"
            @click="filter = 'no-review'"
          >
            双方无需评价
          </button>
        </div>
        <div class="secondary-filters flex items-center gap-6 text-ink tablet:w-full tablet:py-4 mobile:gap-2">
          <div class="sort-control ml-auto flex items-center gap-2 text-[14px] mobile:gap-1">
            <SlidersHorizontal class="mobile:hidden" :size="16" />
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
      <div v-else class="empty-state rounded-md bg-canvas px-6 py-16 text-center mobile:px-5 mobile:py-12">
        <span class="
          mx-auto mb-6 grid size-16 place-items-center rounded-full
          bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--color-canvas))] text-primary-active
        "><Search :size="30" /></span>
        <h3 class="text-[20px] font-medium leading-[1.2] mobile:text-[18px]">
          {{
            matches.length ? "暂无筛选结果" : "暂无匹配活动"
          }}
        </h3>
      </div>
    </section>
  </div>
</template>
