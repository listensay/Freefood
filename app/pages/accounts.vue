<script setup lang="ts">
import { ArrowLeft, ArrowRight, Link2, LogOut } from "@lucide/vue";
import { MEITUAN_ACTIVITY_URL } from "#shared/meituan";

const {
  data, loaded, busy, connectComputerWeChat, connectMeituanBrowser, disconnect,
} = useFoodApp();
useHead({ title: "账号管理 · 叠个饭" });
</script>

<template>
  <div>
    <section class="page-heading">
      <div>
        <h1>账号管理</h1>
      </div>
      <NuxtLink class="button secondary" to="/">
        <ArrowLeft :size="16" />返回首页
      </NuxtLink>
    </section>
    <div class="account-grid">
      <section class="account-panel">
        <header>
          <span class="platform-logo xiaochan-logo">蚕</span>
          <div>
            <h2>小蚕霸王餐</h2>
            <span>{{ data.connections.xiaochan.label }}</span>
          </div>
          <button
            v-if="data.connections.xiaochan.state !== 'disconnected'"
            class="text-button"
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
        <h3>微信登录</h3>
        <button
          class="button primary full-width"
          :disabled="!!busy || !loaded || data.connections.xiaochan.state === 'connected'"
          @click="connectComputerWeChat('xiaochan')"
        >
          <Link2 :size="16" />{{ busy === "xiaochan-wechat" ? "连接中…" : "连接电脑微信" }}
        </button>
      </section>
      <section class="account-panel">
        <header>
          <span class="platform-logo waimai-logo">歪</span>
          <div>
            <h2>歪麦霸王餐</h2>
            <span>{{ data.connections.waimai.label }}</span>
          </div>
          <button
            v-if="data.connections.waimai.state !== 'disconnected'"
            class="text-button"
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
        <h3>微信登录</h3>
        <button
          class="button primary full-width"
          :disabled="!!busy || !loaded || data.connections.waimai.state === 'connected'"
          @click="connectComputerWeChat('waimai')"
        >
          <Link2 :size="16" />{{ busy === 'waimai-wechat' ? '连接中…' : '连接电脑微信' }}
        </button>
      </section>
      <section class="account-panel">
        <header>
          <span class="platform-logo meituan-logo">美</span>
          <div>
            <h2>美团试吃官</h2>
            <span>{{ data.connections.meituan.label }}</span>
          </div>
          <button
            v-if="data.connections.meituan.state !== 'disconnected'"
            class="text-button"
            :disabled="!!busy"
            @click="disconnect('meituan')"
          >
            <LogOut :size="14" />断开
          </button>
        </header>
        <h3>试吃官登录</h3>
        <a
          class="button secondary full-width"
          :href="MEITUAN_ACTIVITY_URL"
          target="_blank"
          rel="noopener noreferrer"
        ><ArrowRight :size="16" />试吃官页面</a>
        <button
          class="button primary full-width verify-button"
          :disabled="!!busy || !loaded"
          @click="connectMeituanBrowser"
        ><Link2 :size="16" />{{ busy === "meituan-browser" ? "连接中…" : "连接 Chrome" }}</button>
      </section>
    </div>
  </div>
</template>
