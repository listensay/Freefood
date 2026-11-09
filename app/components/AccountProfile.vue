<script setup lang="ts">
import RemoteImage from "./RemoteImage.vue";
import { UserRound } from "@lucide/vue";
import type { AccountProfile } from "#shared/types";

defineProps<{ profile: AccountProfile }>();
</script>

<template>
  <div class="account-profile mb-6 flex [align-items:start] gap-3">
    <div class="account-avatar grid size-12 flex-[0_0_48px] place-items-center overflow-hidden rounded-full bg-surface-soft text-muted">
      <RemoteImage
        :src="profile.avatar"
        alt="用户头像"
      ><UserRound :size="24" aria-hidden="true" /></RemoteImage>
    </div>
    <dl class="m-0 min-w-0 text-[13px] leading-[1.5]">
      <div class="flex gap-2" v-if="profile.nickname"><dt class="shrink-0 text-muted">昵称</dt><dd class="m-0 wrap-anywhere">{{ profile.nickname }}</dd></div>
      <div class="flex gap-2" v-if="profile.phone"><dt class="shrink-0 text-muted">手机号</dt><dd class="m-0 wrap-anywhere">{{ profile.phone }}</dd></div>
      <div class="flex gap-2"><dt class="shrink-0 text-muted">用户 ID</dt><dd class="m-0 wrap-anywhere">{{ profile.userId }}</dd></div>
    </dl>
  </div>
</template>
