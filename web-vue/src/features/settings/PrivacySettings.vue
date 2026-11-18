<script setup lang="ts">
import { useSettingsContext } from "./useSettings";
const {
  emit,
  chat,
  busy,
  privacy,
  exceptions,
  rulesExtra,
  extraNames,
  rawPrivacy,
  rules,
  exceptionRules,
  open,
  savePrivacy,
  saveExtra,
} = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <div class="vue-action-list">
      <button @click="open('blocked')">已屏蔽的用户</button
      ><button @click="open('sessions')">所有活跃会话</button
      ><button @click="open('security')">两步验证</button
      ><button @click="open('lock')">设置锁定码</button
      ><button
        @click="
          chat.locked.value = true;
          emit('close');
        "
      >
        立即锁定
      </button>
    </div>
    <form class="vue-fields" @submit.prevent="savePrivacy">
      <label v-for="[key, label] in rules" :key="key"
        >{{ label
        }}<select
          v-model="privacy[key]"
          :disabled="
            key === 'invite_visibility' && privacy.can_manage_privacy === false
          "
        >
          <option value="everyone">所有人</option>
          <option value="contacts">我的联系人</option>
          <option v-if="key !== 'phone_search_visibility'" value="nobody">
            无人
          </option>
        </select></label
      ><label v-for="[key, label] in exceptionRules" :key="key"
        >{{ label }}（每行一个账号）<textarea
          v-model="exceptions[key]"
        ></textarea></label
      ><label
        >离线自动注销<select v-model="privacy.account_auto_delete_days">
          <option
            v-for="[days, label] in [
              [0, '永不'],
              [30, '1月'],
              [90, '3月'],
              [180, '6月'],
              [365, '1年'],
            ]"
            :key="days"
            :value="days"
          >
            {{ label }}
          </option>
        </select></label
      ><label
        ><input
          v-model="privacy.show_active_sessions"
          type="checkbox"
        />显示活跃会话</label
      ><label
        >通话点对点<select v-model="privacy.voice_call_peer_to_peer">
          <option value="everyone">所有人</option>
          <option value="contacts">联系人</option>
          <option value="nobody">无人</option>
        </select></label
      ><button class="primary" :disabled="busy">保存隐私</button>
    </form>
    <form class="vue-fields" @submit.prevent="saveExtra">
      <h3>临时聊天与群邀请例外</h3>
      <fieldset
        v-for="key in ['temporary_chat', 'group_invites']"
        :key="key"
        :disabled="
          key === 'group_invites' && !rawPrivacy.can_manage_group_invites
        "
      >
        <legend>{{ key === "temporary_chat" ? "临时聊天" : "群邀请" }}</legend>
        <select v-model="rulesExtra[key]!.visibility">
          <option value="everyone">所有人</option>
          <option value="contacts">联系人</option>
          <option value="nobody">无人</option>
        </select>
        <label
          >始终允许（每行一个账号）<textarea
            v-model="extraNames[key]!.allow"
          ></textarea>
        </label>
        <label
          >始终拒绝（每行一个账号）<textarea
            v-model="extraNames[key]!.deny"
          ></textarea>
        </label>
      </fieldset>
      <button class="primary" :disabled="busy">保存例外</button>
    </form>
  </div>
</template>
