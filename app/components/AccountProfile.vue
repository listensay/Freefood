<script setup lang="ts">
import { UserRound } from "@lucide/vue";
import type { AccountProfile } from "#shared/types";

const props = defineProps<{ profile: AccountProfile }>();
const avatarFailed = ref(false);
watch(() => props.profile.avatar, () => { avatarFailed.value = false; });
</script>

<template>
  <div class="account-profile">
    <div class="account-avatar">
      <img
        v-if="profile.avatar && !avatarFailed"
        :src="profile.avatar"
        alt="用户头像"
        referrerpolicy="no-referrer"
        @error="avatarFailed = true"
      />
      <UserRound v-else :size="24" aria-hidden="true" />
    </div>
    <dl>
      <div v-if="profile.nickname"><dt>昵称</dt><dd>{{ profile.nickname }}</dd></div>
      <div v-if="profile.phone"><dt>手机号</dt><dd>{{ profile.phone }}</dd></div>
      <div><dt>用户 ID</dt><dd>{{ profile.userId }}</dd></div>
    </dl>
  </div>
</template>
