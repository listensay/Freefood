<script setup lang="ts">
import { BookOpen, Check, ChevronDown, CircleHelp, Link2, MapPin, Settings2, X } from "@lucide/vue";

const {
  data, busy, notice, filter, bawangcanProvider,
  locationDialog, locationForm, locationError,
  openLocation, locateAddress, saveLocation,
} = provideFoodApp();
</script>

<template>
  <NuxtRouteAnnouncer />
  <div class="app-shell">
    <header class="site-header">
      <div class="header-inner">
        <NuxtLink
          to="/"
          class="brand"
          aria-label="叠个饭首页"
          @click="filter = 'all'"
        >
          <img class="brand-mark" src="/icon-512.png" width="42" height="42" alt="" />
          <span>叠个饭</span>
        </NuxtLink>
        <nav class="main-nav" aria-label="主导航">
          <NuxtLink to="/" exact-active-class="active" @click="filter = 'all'">
            <Link2 :size="20" />首页</NuxtLink
          ><NuxtLink to="/accounts" exact-active-class="active" @click="filter = 'all'">
            <Settings2 :size="19" />账号管理</NuxtLink
          ><NuxtLink to="/guide" exact-active-class="active" @click="filter = 'all'">
            <BookOpen :size="19" />使用指南
          </NuxtLink>
        </nav>
        <div class="topbar-actions">
          <button class="location-button" :disabled="busy === 'locate'" @click="openLocation">
            <MapPin :size="16" /><span>{{
              busy === "locate" ? "定位中…" : data.location?.label || "设置收餐地址"
            }}</span
            ><ChevronDown :size="14" /></button
          >
        </div>
      </div>
    </header>
    <div class="workspace">
      <main class="main-content">
        <div
          v-if="notice"
          class="notice"
          :class="{ 'notice-error': notice.error }"
          :role="notice.error ? 'alert' : 'status'"
        >
          <CircleHelp v-if="notice.error" :size="18" /><Check
            v-else
            :size="18"
          /><span>{{ notice.text }}</span
          ><button aria-label="关闭提示" @click="notice = null">
            <X :size="16" />
          </button>
        </div>
        <NuxtPage />
      </main>
    </div>
  </div>
  <dialog
    ref="locationDialog"
    class="location-dialog"
    aria-label="收餐地址"
    @click="$event.target === locationDialog && locationDialog?.close()"
  >
    <form novalidate @submit.prevent="saveLocation" @input="($event.target as HTMLInputElement).removeAttribute('aria-invalid'); locationError = ''">
      <header class="dialog-header">
        <h2>更换收餐地址</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭地址设置"
          @click="locationDialog?.close()"
        >
          <X :size="21" />
        </button>
      </header>
      <button
        type="button"
        class="button secondary full-width"
        :disabled="!!busy"
        @click="locateAddress"
      >
        <MapPin :size="16" />{{ busy === "locate" ? "定位中…" : "使用当前位置" }}
      </button>
      <p v-if="locationError" class="inline-error" role="alert">{{ locationError }}</p>
      <label
        >地址名称<input
          v-model="locationForm.label"
          required
          maxlength="100"
          placeholder="收餐地址名称" /></label
      ><label
        >城市名称<input
          v-model="locationForm.cityName"
          maxlength="50"
          :required="bawangcanProvider === 'waimai'"
          placeholder="例如：上海市" /></label
      ><label
        >城市代码<input
          v-model.number="locationForm.cityCode"
          type="number"
          required
          min="100000"
          max="999999"
          placeholder="六位城市代码"
      /></label>
      <div class="coordinate-fields">
        <label
          >纬度（GCJ-02）<input
            v-model.number="locationForm.latitude"
            type="number"
            step="any"
            required
            min="-90"
            max="90" /></label
        ><label
          >经度（GCJ-02）<input
            v-model.number="locationForm.longitude"
            type="number"
            step="any"
            required
            min="-180"
            max="180"
        /></label>
      </div>
      <button class="button primary full-width" :disabled="!!busy">
        {{ busy === "location" ? "保存中…" : "保存地址" }}
      </button>
    </form>
  </dialog>
  <EnrollmentScheduleDialog />
</template>
