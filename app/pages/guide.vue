<script setup lang="ts">

import { Link2, ShieldCheck, SlidersHorizontal } from "@lucide/vue";

</script>

<template>
  <div>
    <section class="page-heading mb-8 flex items-center justify-between gap-6 mobile:mb-6 mobile:gap-3">
      <div>
        <h1>使用指南</h1>
      </div>
    </section>
    <section class="guide-main max-w-[65ch]">
      <h2>账号连接</h2>
      <div class="guide-entry mt-8 flex gap-4">
        <Link2 class="mt-0.5 text-primary-active" :size="22" />
        <div>
          <h3 class="mb-2">小蚕霸王餐</h3>
          <p class="text-[14px]">在电脑微信的小蚕小程序登录后，选择「连接电脑微信」。</p>
        </div>
      </div>
      <div class="guide-entry mt-8 flex gap-4">
        <Link2 class="mt-0.5 text-primary-active" :size="22" />
        <div>
          <h3 class="mb-2">歪麦霸王餐</h3>
          <p class="text-[14px]">在电脑微信的歪麦小程序登录后，选择「连接电脑微信」。</p>
        </div>
      </div>
      <div class="guide-entry mt-8 flex gap-4">
        <ShieldCheck class="mt-0.5 text-primary-active" :size="22" />
        <div>
          <h3 class="mb-2">美团试吃官</h3>
          <p class="text-[14px]">在 Chrome 的试吃官页面登录后，选择「连接 Chrome」。</p>
        </div>
      </div>
      <div class="guide-entry mt-8 flex gap-4">
        <SlidersHorizontal class="mt-0.5 text-primary-active" :size="22" />
        <div>
          <h3 class="mb-2">活动数据</h3>
          <p class="text-[14px]">连接账号后，在首页同步活动并报名小蚕活动。</p>
        </div>
      </div>
    </section>
  </div>
</template>
