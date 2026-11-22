<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { get, post } from "../../api/client";
import { useSession } from "../../stores/session";

const props = defineProps<{ userId: number; active: boolean }>();
const session = useSession();
const status = ref<{ available: boolean; reason?: string } | null>(null);
const loading = ref(false),
  revealing = ref(false),
  challenge = ref(false);
const adminPassword = ref(""),
  password = ref(""),
  error = ref("");
let epoch = 0,
  controller: AbortController | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
// HTML single-line inputs remove CR/LF. Show an unambiguous representation for
// such credentials, and copy directly from the response rather than the DOM.
const escaped = computed(() =>
  /[\u0000-\u001f\u007f\u2028\u2029]/.test(password.value),
);
const displayedPassword = computed(() => {
  if (!password.value) return "••••••••";
  return escaped.value
    ? JSON.stringify(password.value)
        .replace(/\u007f/g, "\\u007f")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029")
    : password.value;
});
const help = computed(() => {
  if (loading.value) return "正在检查密码记录…";
  if (status.value?.available)
    return "查看需验证当前管理员密码，30 秒后自动隐藏。";
  if (status.value?.reason === "not_configured")
    return "服务器尚未配置密码加密密钥，暂不能查看密码。";
  if (status.value?.reason === "key_unavailable")
    return "加密密钥已变更，请恢复原密钥或重新设置该用户的密码。";
  if (status.value?.reason === "not_recorded")
    return "该账号尚无可查看的密码记录。历史哈希无法还原，重新设置密码后可查看。";
  return "密码记录暂不可用。";
});
function conceal() {
  epoch++;
  controller?.abort();
  controller = null;
  clearTimeout(hideTimer);
  password.value = adminPassword.value = "";
  challenge.value = revealing.value = false;
}
watch(
  [() => props.userId, () => props.active, session.generation, session.isSuper],
  async () => {
    conceal();
    status.value = null;
    error.value = "";
    loading.value = false;
    if (!props.active || !session.isSuper.value) return;
    const current = epoch;
    const abort = new AbortController();
    controller = abort;
    loading.value = true;
    try {
      const result = await get<{ available: boolean; reason?: string }>(
        "/admin/users/password-status?user_id=" + props.userId,
        abort.signal,
      );
      if (current === epoch) status.value = result;
    } catch (failure: any) {
      if (current === epoch && !abort.signal.aborted)
        error.value = failure.message || "密码记录加载失败";
    } finally {
      if (current === epoch) {
        loading.value = false;
        controller = null;
      }
    }
  },
  { immediate: true, flush: "sync" },
);
async function reveal() {
  if (
    !adminPassword.value ||
    revealing.value ||
    !props.active ||
    !session.isSuper.value
  )
    return;
  const current = epoch;
  const abort = new AbortController();
  controller = abort;
  revealing.value = true;
  error.value = "";
  const entered = adminPassword.value;
  adminPassword.value = "";
  try {
    const result = await post<{ password: string }>(
      "/admin/users/password-reveal",
      {
        user_id: props.userId,
        admin_password: entered,
      },
      abort.signal,
    );
    if (
      current !== epoch ||
      abort.signal.aborted ||
      !props.active ||
      !session.isSuper.value ||
      document.hidden
    )
      return;
    if (typeof result.password !== "string" || !result.password)
      throw new Error("密码响应异常，请重试");
    challenge.value = false;
    password.value = result.password;
    hideTimer = setTimeout(conceal, 30000);
  } catch (failure: any) {
    if (current === epoch && !abort.signal.aborted)
      error.value = failure.message || "密码查看失败";
  } finally {
    if (current === epoch) {
      revealing.value = false;
      controller = null;
    }
  }
}
function dismissChallenge() {
  if (revealing.value) conceal();
  adminPassword.value = "";
  challenge.value = false;
}
async function copyPassword() {
  if (!password.value) return;
  const current = epoch;
  try {
    await navigator.clipboard.writeText(password.value);
    if (current === epoch) ElMessage.success("密码已复制");
  } catch {
    if (current === epoch)
      error.value = "无法访问剪贴板，请检查浏览器的剪贴板权限";
  }
}
function visibilityChanged() {
  if (document.hidden) windowBlurred();
}
function windowBlurred() {
  if (password.value || revealing.value || challenge.value) conceal();
}
window.addEventListener("blur", windowBlurred);
document.addEventListener("visibilitychange", visibilityChanged);
onBeforeUnmount(() => {
  conceal();
  window.removeEventListener("blur", windowBlurred);
  document.removeEventListener("visibilitychange", visibilityChanged);
});
</script>

<template>
  <section class="user-password-viewer mb-5" aria-label="用户密码">
    <div class="flex items-center justify-between mb-2">
      <span class="text-sm">用户密码</span>
      <span v-if="password">
        <el-button text type="primary" @click="copyPassword"
          >复制原始密码</el-button
        >
        <el-button text type="primary" @click="conceal">隐藏密码</el-button>
      </span>
      <el-button
        v-else
        text
        type="primary"
        :disabled="!status?.available || loading"
        @click="
          error = '';
          challenge = true;
        "
        >查看密码</el-button
      >
    </div>
    <el-input
      :model-value="displayedPassword"
      readonly
      autocomplete="off"
      aria-label="当前用户密码"
    />
    <p v-if="escaped" class="field-help mt-2">
      密码含换行或控制字符，以上按 JSON
      转义显示（含引号）；「复制原始密码」会复制原始值。
    </p>
    <p class="field-help mt-2">{{ help }}</p>
    <p v-if="error && !challenge" role="alert" class="text-danger text-sm mt-2">
      {{ error }}
    </p>
    <el-dialog
      v-model="challenge"
      title="验证管理员身份"
      width="400px"
      append-to-body
      :close-on-click-modal="false"
      :close-on-press-escape="!revealing"
      :show-close="!revealing"
      destroy-on-close
      @close="dismissChallenge"
    >
      <p class="text-sm mb-4">
        输入当前后台账号的密码，查看操作会记录到审计日志。
      </p>
      <el-input
        v-model="adminPassword"
        type="password"
        show-password
        autocomplete="off"
        aria-label="当前管理员密码"
        placeholder="请输入管理员密码"
        maxlength="256"
        :disabled="revealing"
        @keyup.enter="reveal"
      />
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        class="mt-4"
      />
      <template #footer>
        <el-button :disabled="revealing" @click="dismissChallenge"
          >取消</el-button
        >
        <el-button
          type="primary"
          :loading="revealing"
          :disabled="!adminPassword || revealing"
          @click="reveal"
          >验证并查看</el-button
        >
      </template>
    </el-dialog>
  </section>
</template>
