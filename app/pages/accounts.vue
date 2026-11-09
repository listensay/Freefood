<script setup lang="ts">
import { useFoodApp } from "../composables/useFoodApp";
import AccountProfile from "../components/AccountProfile.vue";
import { ArrowRight, Link2, LogOut } from "@lucide/vue";
import { MEITUAN_ACTIVITY_URL } from "#shared/meituan";

const {
  data, loaded, busy, connectComputerWeChat, connectMeituanBrowser, disconnect,
} = useFoodApp();
</script>

<template>
  <div>
    <section class="page-heading mb-8 flex items-center justify-between gap-6 mobile:mb-6 mobile:gap-3">
      <div>
        <h1>账号管理</h1>
      </div>
    </section>
    <div class="account-grid grid grid-cols-3 auto-rows-[1fr] items-stretch gap-6 compact:grid-cols-2 tablet:grid-cols-1">
      <section class="
        account-panel min-w-0 rounded-md border border-hairline-soft bg-canvas p-6
        shadow-[0_2px_8px_rgb(0_0_0_/_3%)] compact:last:col-span-full tablet:last:col-auto
      ">
        <header class="mb-6 flex items-center gap-3 border-b border-b-hairline-soft pb-6">
          <span class="
            platform-logo xiaochan-logo grid size-11 shrink-0 place-items-center rounded-md text-[22px]
            font-semibold leading-none tablet:size-10 mobile:rounded-[10px]
            bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--color-canvas))] text-primary-active
          ">蚕</span>
          <div>
            <h2 class="text-[16px] leading-[1.25] tracking-normal">小蚕霸王餐</h2>
            <span class="mt-[5px] block text-[13px] text-muted">{{ data.connections.xiaochan.label }}</span>
          </div>
          <button
            v-if="data.connections.xiaochan.state !== 'disconnected'"
            class="
              ml-auto text-button inline-flex min-h-10 items-center justify-center gap-1.5 rounded-sm p-2
              text-[13px] text-ink whitespace-nowrap not-disabled:hover:bg-surface-soft disabled:text-muted
              disabled:opacity-50
            "
            :disabled="!!busy"
            @click="disconnect('xiaochan')"
          >
            <LogOut :size="14" />断开
          </button>
        </header>
        <AccountProfile
          v-if="data.connections.xiaochan.profile"
          :key="data.connections.xiaochan.profile.userId"
          :profile="data.connections.xiaochan.profile"
        />
        <h3 class="mb-4 text-[14px]">微信登录</h3>
        <button
          class="
            button primary full-width inline-flex items-center justify-center gap-2 border font-semibold
            leading-[1.25] whitespace-nowrap no-underline transition-[background,border-color] duration-160
            ease-[ease] min-h-12 rounded-sm px-3 py-[13px] text-[14px] bg-primary border-primary text-on-primary
            not-disabled:hover:bg-primary-active not-disabled:hover:border-primary-active
            not-disabled:active:bg-primary-active not-disabled:active:border-primary-active
            disabled:bg-primary-disabled disabled:border-primary-disabled disabled:text-on-primary w-full
          "
          :disabled="!!busy || !loaded || data.connections.xiaochan.state === 'connected'"
          @click="connectComputerWeChat('xiaochan')"
        >
          <Link2 :size="16" />{{ busy === "xiaochan-wechat" ? "连接中…" : "连接电脑微信" }}
        </button>
      </section>
      <section class="
        account-panel min-w-0 rounded-md border border-hairline-soft bg-canvas p-6
        shadow-[0_2px_8px_rgb(0_0_0_/_3%)] compact:last:col-span-full tablet:last:col-auto
      ">
        <header class="mb-6 flex items-center gap-3 border-b border-b-hairline-soft pb-6">
          <span class="
            platform-logo waimai-logo grid size-11 shrink-0 place-items-center rounded-md text-[22px]
            font-semibold leading-none tablet:size-10 mobile:rounded-[10px]
            bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--color-canvas))] text-primary-active
          ">歪</span>
          <div>
            <h2 class="text-[16px] leading-[1.25] tracking-normal">歪麦霸王餐</h2>
            <span class="mt-[5px] block text-[13px] text-muted">{{ data.connections.waimai.label }}</span>
          </div>
          <button
            v-if="data.connections.waimai.state !== 'disconnected'"
            class="
              ml-auto text-button inline-flex min-h-10 items-center justify-center gap-1.5 rounded-sm p-2
              text-[13px] text-ink whitespace-nowrap not-disabled:hover:bg-surface-soft disabled:text-muted
              disabled:opacity-50
            "
            :disabled="!!busy"
            @click="disconnect('waimai')"
          >
            <LogOut :size="14" />断开
          </button>
        </header>
        <AccountProfile
          v-if="data.connections.waimai.profile"
          :key="data.connections.waimai.profile.userId"
          :profile="data.connections.waimai.profile"
        />
        <h3 class="mb-4 text-[14px]">微信登录</h3>
        <button
          class="
            button primary full-width inline-flex items-center justify-center gap-2 border font-semibold
            leading-[1.25] whitespace-nowrap no-underline transition-[background,border-color] duration-160
            ease-[ease] min-h-12 rounded-sm px-3 py-[13px] text-[14px] bg-primary border-primary text-on-primary
            not-disabled:hover:bg-primary-active not-disabled:hover:border-primary-active
            not-disabled:active:bg-primary-active not-disabled:active:border-primary-active
            disabled:bg-primary-disabled disabled:border-primary-disabled disabled:text-on-primary w-full
          "
          :disabled="!!busy || !loaded || data.connections.waimai.state === 'connected'"
          @click="connectComputerWeChat('waimai')"
        >
          <Link2 :size="16" />{{ busy === 'waimai-wechat' ? '连接中…' : '连接电脑微信' }}
        </button>
      </section>
      <section class="
        account-panel min-w-0 rounded-md border border-hairline-soft bg-canvas p-6
        shadow-[0_2px_8px_rgb(0_0_0_/_3%)] compact:last:col-span-full tablet:last:col-auto
      ">
        <header class="mb-6 flex items-center gap-3 border-b border-b-hairline-soft pb-6">
          <span class="
            platform-logo meituan-logo grid size-11 shrink-0 place-items-center rounded-md text-[22px]
            font-semibold leading-none tablet:size-10 mobile:rounded-[10px] bg-primary text-on-primary
          ">美</span>
          <div>
            <h2 class="text-[16px] leading-[1.25] tracking-normal">美团试吃官</h2>
            <span class="mt-[5px] block text-[13px] text-muted">{{ data.connections.meituan.label }}</span>
          </div>
          <button
            v-if="data.connections.meituan.state !== 'disconnected'"
            class="
              ml-auto text-button inline-flex min-h-10 items-center justify-center gap-1.5 rounded-sm p-2
              text-[13px] text-ink whitespace-nowrap not-disabled:hover:bg-surface-soft disabled:text-muted
              disabled:opacity-50
            "
            :disabled="!!busy"
            @click="disconnect('meituan')"
          >
            <LogOut :size="14" />断开
          </button>
        </header>
        <h3 class="mb-4 text-[14px]">试吃官登录</h3>
        <a
          class="
            compact:mr-3 compact:w-auto tablet:mr-0 tablet:w-full button secondary full-width inline-flex
            items-center justify-center gap-2 border font-semibold leading-[1.25] whitespace-nowrap no-underline
            transition-[background,border-color] duration-160 ease-[ease] min-h-12 rounded-sm px-3 py-[13px]
            text-[14px] bg-canvas border-hairline text-ink not-disabled:hover:bg-surface-soft
            not-disabled:hover:border-border-strong not-disabled:active:bg-surface-soft
            not-disabled:active:border-border-strong disabled:border-hairline disabled:text-muted w-full
          "
          :href="MEITUAN_ACTIVITY_URL"
          target="_blank"
          rel="noopener noreferrer"
        ><ArrowRight :size="16" />试吃官页面</a>
        <button
          class="
            compact:mr-3 compact:w-auto tablet:mr-0 tablet:w-full button primary full-width verify-button mt-3
            inline-flex items-center justify-center gap-2 border font-semibold leading-[1.25] whitespace-nowrap
            no-underline transition-[background,border-color] duration-160 ease-[ease] min-h-12 rounded-sm px-3
            py-[13px] text-[14px] bg-primary border-primary text-on-primary not-disabled:hover:bg-primary-active
            not-disabled:hover:border-primary-active not-disabled:active:bg-primary-active
            not-disabled:active:border-primary-active disabled:bg-primary-disabled
            disabled:border-primary-disabled disabled:text-on-primary w-full
          "
          :disabled="!!busy || !loaded"
          @click="connectMeituanBrowser"
        ><Link2 :size="16" />{{ busy === "meituan-browser" ? "连接中…" : "连接 Chrome" }}</button>
      </section>
    </div>
  </div>
</template>
