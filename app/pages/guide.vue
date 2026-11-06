<script setup lang="ts">
import { Link2, ShieldCheck, SlidersHorizontal } from "@lucide/vue";

useHead({ title: "使用指南 · 叠个饭" });
</script>

<template>
  <div>
    <section class="page-heading">
      <div>
        <h1>使用指南</h1>
      </div>
    </section>
    <section class="guide-main">
      <h2>账号连接</h2>
      <div class="guide-entry">
        <Link2 :size="22" />
        <div>
          <h3>小蚕霸王餐</h3>
          <p>在电脑微信的小蚕小程序登录后，选择「连接电脑微信」。</p>
        </div>
      </div>
      <div class="guide-entry">
        <Link2 :size="22" />
        <div>
          <h3>歪麦霸王餐</h3>
          <p>在电脑微信的歪麦小程序登录后，选择「连接电脑微信」。</p>
        </div>
      </div>
      <div class="guide-entry">
        <ShieldCheck :size="22" />
        <div>
          <h3>美团试吃官</h3>
          <p>在 Chrome 的试吃官页面登录后，选择「连接 Chrome」。</p>
        </div>
      </div>
      <div class="guide-entry">
        <SlidersHorizontal :size="22" />
        <div>
          <h3>活动数据</h3>
          <p>连接账号后，在首页同步活动并报名小蚕活动。</p>
        </div>
      </div>
    </section>
  </div>
</template>
