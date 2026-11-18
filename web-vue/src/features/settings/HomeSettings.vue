<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
import AvatarImage from "../../components/AvatarImage.vue";
const { chat, titles, scale, open, setScale } = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <AvatarImage
      :name="chat.me.value?.nickname"
      :src="chat.me.value?.avatar_url"
    />
    <h3>{{ chat.me.value?.nickname }}</h3>
    <nav class="vue-settings-menu">
      <button
        v-for="item in [
          'profile',
          'notifications',
          'privacy',
          'chat',
          'media',
          'advanced',
          'language',
          'password',
          'security',
          'help',
        ] as const"
        :key="item"
        @click="open(item)"
      >
        {{ titles[item] }}
      </button>
    </nav>
    <label
      >默认界面缩放<select v-model.number="scale" @change="setScale">
        <option
          v-for="value in [1, 1.25, 1.5, 2, 2.5, 3]"
          :key="value"
          :value="value"
        >
          {{ value * 100 }}%
        </option>
      </select></label
    ><button @click="chat.logout">退出登录</button>
  </div>
</template>
