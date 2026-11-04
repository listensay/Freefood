<script setup lang="ts">
import { ArrowRight, CircleHelp, X } from "@lucide/vue";
import type { StoreMatch } from "#shared/types";
import {
  calculatePrice,
  money,
  ruleLabel,
  toCents,
} from "#shared/utils/pricing";
const dialog = ref<HTMLDialogElement>();
const selected = ref<StoreMatch>();
const paid = ref(""),
  fees = ref("0"),
  couponUsed = ref(false),
  sameStore = ref(false),
  canStack = ref(false);
const calculation = computed(() => {
  if (!selected.value) return { result: null, error: "" };
  try {
    return {
      result: calculatePrice({
        paidCents: toCents(paid.value),
        excludedFeesCents: toCents(fees.value),
        xiaochan: selected.value.xiaochan,
        meituan: selected.value.meituan,
        couponUsed: couponUsed.value,
        sameStoreConfirmed: sameStore.value,
        stackingConfirmed: canStack.value,
      }),
      error: "",
    };
  } catch (error: any) {
    return { result: null, error: error.message };
  }
});
async function open(match: StoreMatch) {
  selected.value = match;
  paid.value = money(
    Math.max(
      match.xiaochan.rule.thresholdCents,
      match.meituan.rule.thresholdCents,
    ),
  );
  fees.value = "0";
  couponUsed.value = false;
  sameStore.value = match.confidence === "id";
  canStack.value = false;
  await nextTick();
  dialog.value?.showModal();
}
defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="calculator-dialog"
    aria-label="价格计算器"
    @click="$event.target === dialog && dialog?.close()"
  >
    <div v-if="selected" class="calculator-content">
      <header class="dialog-header">
        <div>
          <h2>价格计算器</h2>
        </div>
        <button
          class="icon-button"
          aria-label="关闭价格计算器"
          @click="dialog?.close()"
        >
          <X :size="21" />
        </button>
      </header>
      <div class="calculator-store">
        <h3>{{ selected.xiaochan.name }}</h3>
        <p>{{ selected.confidence === 'id' ? '已匹配' : '分店待核验' }}</p>
      </div>
      <form @submit.prevent>
        <div class="money-fields">
          <label for="paid"
            >订单实付金额<span class="input-with-unit"
              ><b>¥</b
              ><input
                id="paid"
                v-model="paid"
                inputmode="decimal"
                placeholder="0.00" /></span></label
          ><label for="fees"
            >不计返现费用<span class="input-with-unit"
              ><b>¥</b
              ><input
                id="fees"
                v-model="fees"
                inputmode="decimal"
                placeholder="0.00" /></span
          ></label>
        </div>
        <label class="check-line"
          ><input
            v-model="couponUsed"
            type="checkbox"
          />使用美团活动页优惠券</label
        >
        <div class="calculation-breakdown">
          <div>
            <span>订单实付</span
            ><strong
              >¥{{
                calculation.result ? money(calculation.result.paidCents) : "—"
              }}</strong
            >
          </div>
          <div class="deduction">
            <span><span class="provider-dot xiaochan-dot"></span>小蚕返现</span
            ><strong
              >− ¥{{
                calculation.result
                  ? money(calculation.result.xiaochanCents)
                  : "—"
              }}</strong
            >
          </div>
          <p>
            {{ ruleLabel(selected.xiaochan.rule) }} ·
            {{ selected.xiaochan.requirement }}
          </p>
          <div class="deduction">
            <span><span class="provider-dot meituan-dot"></span>美团返现</span
            ><strong
              >− ¥{{
                calculation.result
                  ? money(calculation.result.meituanCents)
                  : "—"
              }}</strong
            >
          </div>
          <p>
            {{ ruleLabel(selected.meituan.rule) }} ·
            {{ selected.meituan.requirement }}
          </p>
        </div>
        <div class="calculator-total">
          <span>到手价（试算）</span
          ><strong
            ><small>¥</small
            >{{
              calculation.result
                ? money(calculation.result.theoreticalNetCents)
                : "—"
            }}</strong
          >
          <p v-if="calculation.result">
            单平台到手价：¥{{
              money(calculation.result.singlePlatformNetCents)
            }}
          </p>
        </div>
        <p v-if="calculation.error" class="inline-error" role="alert">
          {{ calculation.error }}
        </p>
        <div class="confirmation-fields">
          <label class="check-line"
            ><input
              v-model="sameStore"
              type="checkbox"
            />已确认同一家分店</label
          ><label class="check-line"
            ><input
              v-model="canStack"
              type="checkbox"
            />已确认返现可叠加及任务要求</label
          >
        </div>
        <div
          v-if="calculation.result?.warnings.length"
          class="calculation-warnings"
        >
          <CircleHelp :size="17" />
          <ul>
            <li v-for="warning in calculation.result.warnings" :key="warning">
              {{ warning }}
            </li>
          </ul>
        </div>
        <div v-if="selected.meituan.url" class="official-links">
          <a
            v-if="selected.meituan.url"
            :href="selected.meituan.url"
            target="_blank"
            rel="noreferrer"
            >美团活动<ArrowRight :size="14" /></a>
        </div>
      </form>
      <button class="button dark full-width" @click="dialog?.close()">
        返回列表
      </button>
    </div>
  </dialog>
</template>
