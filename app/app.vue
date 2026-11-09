<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";
import { provideFoodApp } from "./composables/useFoodApp";
import EnrollmentScheduleDialog from "./components/EnrollmentScheduleDialog.vue";
import RouteAnnouncer from "./components/RouteAnnouncer.vue";
import { BookOpen, ScrollText, Check, ChevronDown, CircleHelp, Link2, MapPin, Settings2, X } from "@lucide/vue";

const {
  data, busy, notice, filter, requiresCityName,
  locationDialog, locationForm, locationError,
  openLocation, locateAddress, saveLocation,
} = provideFoodApp();
</script>

<template>
  <RouteAnnouncer />
  <div class="app-shell min-h-dvh bg-surface-soft">
    <header class="site-header bg-canvas border-b border-b-hairline-soft">
      <div class="
        header-inner mx-auto grid min-h-20 max-w-[1296px] grid-cols-[1fr_auto_1fr] items-center gap-6 px-12
        compact:grid-cols-[auto_1fr_auto] compact:px-8 tablet:grid-cols-2 tablet:gap-4 tablet:px-6 tablet:pt-5
        mobile:gap-3 mobile:px-5 mobile:pt-4 narrow:px-4
      ">
        <RouterLink
          to="/"
          class="
            brand inline-flex w-fit items-center gap-2.5 whitespace-nowrap p-0 text-[25px] font-semibold
            text-primary no-underline compact:text-[22px] mobile:gap-2
          "
          aria-label="叠个饭首页"
          @click="filter = 'all'"
        >
          <img class="brand-mark block size-[42px] shrink-0 rounded-md mobile:size-9 mobile:rounded-[12px]" src="/icon-512.png" width="42" height="42" alt="" />
          <span>叠个饭</span>
        </RouterLink>
        <nav class="
          main-nav flex items-stretch self-stretch gap-8 compact:justify-center compact:gap-6
          tablet:col-span-full tablet:row-start-2 tablet:min-h-14 tablet:justify-between mobile:min-h-[52px]
          mobile:gap-3 narrow:gap-2
        " aria-label="主导航">
          <RouterLink to="/" class="
            relative flex items-center gap-2 whitespace-nowrap py-2 text-[14px] text-muted no-underline
            transition-colors duration-160 ease-[ease] hover:text-ink [&.active]:font-semibold
            [&.active]:text-primary-active [&.active]:after:absolute [&.active]:after:inset-x-0
            [&.active]:after:bottom-0 [&.active]:after:h-0.5 [&.active]:after:bg-primary
            [&.active]:after:content-[''] compact:gap-1.5 mobile:gap-[5px] mobile:text-[13px] narrow:text-[12px]
            [&>svg]:compact:w-[18px] [&>svg]:mobile:w-4 [&>svg]:narrow:hidden
          " exact-active-class="active" @click="filter = 'all'">
            <Link2 :size="20" />首页</RouterLink
          ><RouterLink to="/accounts" class="
            relative flex items-center gap-2 whitespace-nowrap py-2 text-[14px] text-muted no-underline
            transition-colors duration-160 ease-[ease] hover:text-ink [&.active]:font-semibold
            [&.active]:text-primary-active [&.active]:after:absolute [&.active]:after:inset-x-0
            [&.active]:after:bottom-0 [&.active]:after:h-0.5 [&.active]:after:bg-primary
            [&.active]:after:content-[''] compact:gap-1.5 mobile:gap-[5px] mobile:text-[13px] narrow:text-[12px]
            [&>svg]:compact:w-[18px] [&>svg]:mobile:w-4 [&>svg]:narrow:hidden
          " exact-active-class="active" @click="filter = 'all'">
            <Settings2 :size="19" />账号管理</RouterLink
          ><RouterLink to="/guide" class="
            relative flex items-center gap-2 whitespace-nowrap py-2 text-[14px] text-muted no-underline
            transition-colors duration-160 ease-[ease] hover:text-ink [&.active]:font-semibold
            [&.active]:text-primary-active [&.active]:after:absolute [&.active]:after:inset-x-0
            [&.active]:after:bottom-0 [&.active]:after:h-0.5 [&.active]:after:bg-primary
            [&.active]:after:content-[''] compact:gap-1.5 mobile:gap-[5px] mobile:text-[13px] narrow:text-[12px]
            [&>svg]:compact:w-[18px] [&>svg]:mobile:w-4 [&>svg]:narrow:hidden
          " exact-active-class="active" @click="filter = 'all'">
            <BookOpen :size="19" />使用指南
          </RouterLink><RouterLink to="/logs" class="
            relative flex items-center gap-2 whitespace-nowrap py-2 text-[14px] text-muted no-underline
            transition-colors duration-160 ease-[ease] hover:text-ink [&.active]:font-semibold
            [&.active]:text-primary-active [&.active]:after:absolute [&.active]:after:inset-x-0
            [&.active]:after:bottom-0 [&.active]:after:h-0.5 [&.active]:after:bg-primary
            [&.active]:after:content-[''] compact:gap-1.5 mobile:gap-[5px] mobile:text-[13px] narrow:text-[12px]
            [&>svg]:compact:w-[18px] [&>svg]:mobile:w-4 [&>svg]:narrow:hidden
          " exact-active-class="active" @click="filter = 'all'">
            <ScrollText :size="19" />运行日志
          </RouterLink>
        </nav>
        <div class="topbar-actions flex min-w-0 justify-end tablet:col-start-2 tablet:row-start-1">
          <button class="
            location-button inline-flex min-h-11 min-w-0 items-center gap-2 rounded-full px-3 py-2.5 text-[14px]
            not-disabled:hover:bg-surface-soft tablet:pr-0 mobile:gap-1.5 mobile:text-[12px]
          " :disabled="busy === 'locate'" @click="openLocation">
            <MapPin :size="16" /><span class="max-w-44 truncate compact:max-w-30 mobile:max-w-[116px] narrow:max-w-24">{{
              busy === "locate" ? "定位中…" : data.location?.label || "设置收餐地址"
            }}</span
            ><ChevronDown :size="14" /></button
          >
        </div>
      </div>
    </header>
    <div class="workspace min-w-0">
      <main class="
        main-content mx-auto max-w-[1296px] px-12 pt-8 pb-16 compact:px-8 tablet:px-6 tablet:pb-12 mobile:px-5
        mobile:pt-7 mobile:pb-10 narrow:px-4
      ">
        <div
          v-if="notice"
          class="
            notice mb-8 flex items-start gap-3 rounded-sm border border-hairline-soft bg-canvas p-4 text-[14px]
            leading-[1.5] mobile:mb-6 mobile:p-3.5 mobile:text-[13px]
          "
          :class="notice.error ? 'notice-error text-primary-error-text' : 'text-ink'"
          :role="notice.error ? 'alert' : 'status'"
        >
          <CircleHelp class="mt-0.5" v-if="notice.error" :size="18" /><Check
            v-else class="mt-0.5"
            :size="18"
          /><span class="flex-1 wrap-anywhere">{{ notice.text }}</span
          ><button class="grid size-6 place-items-center rounded-full p-0 hover:bg-surface-strong" aria-label="关闭提示" @click="notice = null">
            <X :size="16" />
          </button>
        </div>
        <RouterView v-slot="{ Component, route }">
          <Transition name="page" mode="out-in"
            enter-active-class="page-enter-active [transition:opacity_180ms_ease-out,transform_180ms_cubic-bezier(0.16,1,0.3,1)]"
            leave-active-class="page-leave-active pointer-events-none transition-opacity duration-100 ease-[ease-in]"
            enter-from-class="page-enter-from opacity-0 [transform:translateY(6px)] motion-reduce:opacity-100 motion-reduce:transform-none"
            leave-to-class="page-leave-to opacity-0 motion-reduce:opacity-100 motion-reduce:transform-none"
          >
            <component :is="Component" :key="route.path" />
          </Transition>
        </RouterView>
      </main>
    </div>
  </div>
  <dialog
    ref="locationDialog"
    class="
      location-dialog w-[480px] max-w-[calc(100vw-32px)] max-h-[calc(100dvh-48px)] rounded-lg p-8
      mobile:max-h-[calc(100dvh-32px)] mobile:p-6 overflow-auto
    "
    aria-label="收餐地址"
    @click="$event.target === locationDialog && locationDialog?.close()"
  >
    <form novalidate @submit.prevent="saveLocation" @input="($event.target as HTMLInputElement).removeAttribute('aria-invalid'); locationError = ''">
      <header class="dialog-header mb-6 flex items-center justify-between gap-4">
        <h2 class="text-[22px] leading-[1.2] mobile:text-[20px]">更换收餐地址</h2>
        <button
          type="button"
          class="icon-button grid size-8 place-items-center rounded-full p-0 text-ink hover:bg-surface-strong"
          aria-label="关闭地址设置"
          @click="locationDialog?.close()"
        >
          <X :size="21" />
        </button>
      </header>
      <button
        type="button"
        class="
          button secondary full-width inline-flex items-center justify-center gap-2 border font-semibold
          leading-[1.25] whitespace-nowrap no-underline transition-[background,border-color] duration-160
          ease-[ease] min-h-12 rounded-sm px-[23px] py-[13px] text-[16px] bg-canvas border-hairline text-ink
          not-disabled:hover:bg-surface-soft not-disabled:hover:border-border-strong
          not-disabled:active:bg-surface-soft not-disabled:active:border-border-strong disabled:border-hairline
          disabled:text-muted w-full
        "
        :disabled="!!busy"
        @click="locateAddress"
      >
        <MapPin :size="16" />{{ busy === "locate" ? "定位中…" : "使用当前位置" }}
      </button>
      <p v-if="locationError" class="inline-error mt-4 mb-0 text-[14px] text-primary-error-text" role="alert">{{ locationError }}</p>
      <label class="mt-5 block min-w-0 text-[14px]"
        >地址名称<input class="mt-2 block w-full min-w-0"
          v-model="locationForm.label"
          required
          maxlength="100"
          placeholder="收餐地址名称" /></label
      ><label class="mt-5 block min-w-0 text-[14px]"
        >城市名称<input class="mt-2 block w-full min-w-0"
          v-model="locationForm.cityName"
          maxlength="50"
          :required="requiresCityName"
          placeholder="例如：上海市" /></label
      ><label class="mt-5 block min-w-0 text-[14px]"
        >城市代码<input class="mt-2 block w-full min-w-0"
          v-model.number="locationForm.cityCode"
          type="number"
          required
          min="100000"
          max="999999"
          placeholder="六位城市代码"
      /></label>
      <div class="coordinate-fields grid grid-cols-2 gap-4 mobile:gap-3">
        <label class="mt-5 block min-w-0 text-[14px]"
          >纬度（GCJ-02）<input class="mt-2 block w-full min-w-0"
            v-model.number="locationForm.latitude"
            type="number"
            step="any"
            required
            min="-90"
            max="90" /></label
        ><label class="mt-5 block min-w-0 text-[14px]"
          >经度（GCJ-02）<input class="mt-2 block w-full min-w-0"
            v-model.number="locationForm.longitude"
            type="number"
            step="any"
            required
            min="-180"
            max="180"
        /></label>
      </div>
      <button class="
        mt-6 button primary full-width inline-flex items-center justify-center gap-2 border font-semibold
        leading-[1.25] whitespace-nowrap no-underline transition-[background,border-color] duration-160
        ease-[ease] min-h-12 rounded-sm px-[23px] py-[13px] text-[16px] bg-primary border-primary
        text-on-primary not-disabled:hover:bg-primary-active not-disabled:hover:border-primary-active
        not-disabled:active:bg-primary-active not-disabled:active:border-primary-active
        disabled:bg-primary-disabled disabled:border-primary-disabled disabled:text-on-primary w-full
      " :disabled="!!busy">
        {{ busy === "location" ? "保存中…" : "保存地址" }}
      </button>
    </form>
  </dialog>
  <EnrollmentScheduleDialog />
</template>
