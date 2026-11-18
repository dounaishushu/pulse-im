<script setup lang="ts">
import { useCredentials } from "./useCredentials";
import type { LoginResult } from "../../api/client";
const props = defineProps<{ requireAvatar: boolean }>();
const emit = defineEmits<{ authenticated: [result: LoginResult] }>();
const auth = useCredentials(
  () => props.requireAvatar,
  (value) => emit("authenticated", value),
);
const {
  form,
  registering,
  busy,
  error,
  showPassword,
  showConfirm,
  twoStep,
  captcha,
  captchaBusy,
  avatar,
  avatarBusy,
  canSubmit,
} = auth;
function tabKey(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  if (busy.value) return;
  registering.value =
    event.key === "Home"
      ? false
      : event.key === "End"
        ? true
        : !registering.value;
  (event.currentTarget as HTMLElement)
    .querySelectorAll<HTMLButtonElement>("[role=tab]")
    [registering.value ? 1 : 0]?.focus();
}
function avatarChanged(event: Event) {
  void auth.chooseAvatar((event.target as HTMLInputElement).files?.[0]);
}
</script>
<template>
  <div
    class="pc-auth-tabs"
    role="tablist"
    aria-label="账号访问方式"
    @keydown="tabKey"
  >
    <button
      type="button"
      role="tab"
      :aria-selected="!registering"
      :tabindex="registering ? -1 : 0"
      aria-controls="auth-panel"
      id="login-tab"
      :disabled="busy"
      @click="registering = false"
    >
      登录</button
    ><button
      type="button"
      role="tab"
      :aria-selected="registering"
      :tabindex="registering ? 0 : -1"
      aria-controls="auth-panel"
      id="register-tab"
      :disabled="busy"
      @click="registering = true"
    >
      注册
    </button>
  </div>
  <div
    role="tabpanel"
    id="auth-panel"
    :aria-labelledby="registering ? 'register-tab' : 'login-tab'"
  >
    <h1>{{ registering ? "创建你的账号" : "欢迎回来" }}</h1>
    <p class="pc-auth-description">
      {{
        registering ? "加入我们，开启新的对话。" : "登录账号，继续你的对话。"
      }}
    </p>
    <form
      id="login-form"
      novalidate
      :aria-busy="busy"
      @submit.prevent="auth.submit"
    >
      <label v-if="registering" for="nickname"
        >昵称<input
          id="nickname"
          v-model="form.nickname"
          :readonly="busy"
          autocomplete="nickname"
          maxlength="32"
          placeholder="怎么称呼你"
      /></label>
      <label for="phone"
        >用户名 / 手机号<input
          id="phone"
          v-model="form.account"
          :readonly="busy"
          required
          autocomplete="username"
          autocapitalize="none"
          :spellcheck="false"
          maxlength="64"
          placeholder="请输入用户名或手机号"
      /></label>
      <label for="password"
        >密码<span class="pc-auth-password"
          ><input
            id="password"
            v-model="form.password"
            :readonly="busy"
            required
            :type="showPassword ? 'text' : 'password'"
            :autocomplete="registering ? 'new-password' : 'current-password'"
            maxlength="128"
            placeholder="请输入密码"
          /><button
            type="button"
            :disabled="busy"
            :aria-label="showPassword ? '隐藏密码' : '显示密码'"
            :aria-pressed="showPassword"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? "隐藏" : "显示" }}
          </button></span
        ></label
      >
      <template v-if="registering">
        <label for="confirm-password"
          >确认密码<input
            id="confirm-password"
            v-model="form.confirm"
            :readonly="busy"
            :type="showConfirm ? 'text' : 'password'"
            autocomplete="new-password"
            maxlength="128"
          />
          <button
            type="button"
            :disabled="busy"
            :aria-label="showConfirm ? '隐藏确认密码' : '显示确认密码'"
            :aria-pressed="showConfirm"
            @click="showConfirm = !showConfirm"
          >
            {{ showConfirm ? "隐藏" : "显示" }}
          </button></label
        >
        <label for="avatar-file"
          >头像{{ requireAvatar ? "（必选）" : "（可选）"
          }}<input
            id="avatar-file"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            :disabled="busy || avatarBusy"
            @change="avatarChanged" /><img
            v-if="avatar"
            :src="avatar"
            width="64"
            height="64"
            alt="头像预览"
        /></label>
        <label for="captcha-code"
          >图形验证码<span class="pc-auth-captcha-row"
            ><input
              id="captcha-code"
              v-model="form.code"
              :readonly="busy"
              maxlength="5"
              autocomplete="off"
              autocapitalize="characters"
            /><button
              type="button"
              :disabled="busy || captchaBusy"
              aria-label="刷新验证码"
              @click="auth.refreshCaptcha"
            >
              <img
                v-if="captcha"
                :src="captcha.image_data_url"
                alt="注册验证码图片"
              /><span v-else>{{ captchaBusy ? "加载中…" : "刷新验证码" }}</span>
            </button></span
          ></label
        >
      </template>
      <label v-if="twoStep" for="two-step-code"
        >两步验证密码或恢复码<input
          id="two-step-code"
          v-model="form.secondFactor"
          :readonly="busy"
          type="password"
          autocomplete="off"
          maxlength="128"
      /></label>
      <p class="error pc-auth-error" role="alert" aria-live="polite">
        {{ error }}
      </p>
      <button
        id="auth-submit"
        class="primary pc-auth-submit"
        type="submit"
        :disabled="!canSubmit"
      >
        <span>{{
          busy ? "正在处理…" : registering ? "创建账号并登录" : "登录"
        }}</span><span aria-hidden="true">→</span>
      </button>
    </form>
  </div>
  <div class="pc-auth-switch">
    <span>{{ registering ? "已经有账号？" : "还没有账号？" }}</span><button
      type="button"
      class="mode-toggle"
      :disabled="busy"
      @click="registering = !registering"
    >
      {{ registering ? "返回登录" : "创建账号" }}
    </button>
  </div>
</template>
