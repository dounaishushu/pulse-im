<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
import AvatarImage from "../../components/AvatarImage.vue";
const { chat, busy, profile, saveProfile, avatar } = useSettingsContext();
</script>
<template>
  <form class="vue-fields" @submit.prevent="saveProfile">
    <AvatarImage
      :name="chat.me.value?.nickname"
      :src="chat.me.value?.avatar_url"
      :media-id="chat.me.value?.avatar_id"
      class="profile-avatar"
    />
    <label
      >头像<input
        type="file"
        accept="image/*"
        :disabled="busy"
        @change="avatar" /></label
    ><label
      >昵称<input v-model="profile.nickname" required maxlength="32" /></label
    ><label
      >账号<input
        v-model="profile.username"
        :disabled="!!chat.me.value?.username" /></label
    ><label>用户 ID<input :value="chat.me.value?.public_id" readonly /></label
    ><label
      >生日<input
        v-model="profile.birthday"
        type="date"
        :disabled="!!chat.me.value?.birthday_change_count" /></label
    ><label
      >性别<select v-model="profile.gender">
        <option value="">未设置</option>
        <option>男</option>
        <option>女</option>
        <option>保密</option>
      </select></label
    ><label>个性签名<input v-model="profile.signature" maxlength="70" /></label
    ><button class="primary" :disabled="busy">保存资料</button>
  </form>
</template>

<style scoped>
.profile-avatar {
  --avatar-size: 64px;
  --avatar-radius: 12px;
}
</style>
