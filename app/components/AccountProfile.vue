<script setup lang="ts">
import RemoteImage from "./RemoteImage.vue";
import { UserRound } from "@lucide/vue";
import type { AccountProfile } from "#shared/types";

defineProps<{ profile: AccountProfile }>();
</script>

<template>
  <div class="account-profile">
    <div class="account-avatar">
      <RemoteImage
        :src="profile.avatar"
        alt="用户头像"
      ><UserRound :size="24" aria-hidden="true" /></RemoteImage>
    </div>
    <dl>
      <div v-if="profile.nickname"><dt>昵称</dt><dd>{{ profile.nickname }}</dd></div>
      <div v-if="profile.phone"><dt>手机号</dt><dd>{{ profile.phone }}</dd></div>
      <div><dt>用户 ID</dt><dd>{{ profile.userId }}</dd></div>
    </dl>
  </div>
</template>
