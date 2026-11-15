<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { ElMessage } from "element-plus";
import { post } from "../../api/client";
import { can } from "../../stores/session";
import { useAction } from "../../composables/useAction";
import type { RecordData } from "../../domain/types";
const props = defineProps<{ modelValue: boolean; users: RecordData[] }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [];
}>();
const open = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});
const password = shallowRef(""),
  confirmPassword = shallowRef(""),
  confirmed = shallowRef(false);
const action = useAction();
let requestID = "",
  payloadKey = "";
watch(
  () => props.modelValue,
  (value) => {
    if (value) {
      password.value = "";
      confirmPassword.value = "";
      confirmed.value = false;
      requestID = "";
      payloadKey = "";
      action.error.value = "";
    }
  },
);
const valid = computed(() => {
  const n = new TextEncoder().encode(password.value).length;
  return (
    can("users", true) &&
    props.users.length > 0 &&
    props.users.length <= 100 &&
    props.users.every((user) => user.status !== "deleted") &&
    n >= 8 &&
    n <= 128 &&
    password.value === confirmPassword.value &&
    confirmed.value
  );
});
async function save() {
  if (!valid.value) return;
  await action.run(async (assertCurrent) => {
    const user_ids = props.users
      .map((user) => Number(user.id))
      .sort((a, b) => a - b);
    const key = JSON.stringify([user_ids, password.value]);
    if (key !== payloadKey) {
      payloadKey = key;
      requestID = crypto.randomUUID();
    }
    const result = await post("/admin/users/password-reset-batch", {
      user_ids,
      password: password.value,
      request_id: requestID,
    });
    assertCurrent();
    if (result.count !== user_ids.length)
      throw new Error("返回数量与所选用户不一致，请刷新后核对");
    password.value = "";
    confirmPassword.value = "";
    payloadKey = "";
    open.value = false;
    emit("saved");
    ElMessage.success(`已重置 ${result.count} 个用户的密码，原登录会话已失效`);
  });
}
</script>
<template>
  <el-dialog
    v-model="open"
    title="批量重置密码"
    width="580px"
    :close-on-click-modal="false"
    :close-on-press-escape="!action.busy.value"
    :show-close="!action.busy.value"
    destroy-on-close
    @closed="
      password = '';
      confirmPassword = '';
      payloadKey = '';
    "
  >
    <p class="mb-3">
      将为以下
      {{
        users.length
      }}
      个用户设置同一个新密码，原登录会话立即失效。账号原有的冻结状态保持不变。
    </p>
    <div class="reset-users">
      <el-tag v-for="user in users" :key="user.id"
        >{{ user.account || user.username || user.nickname }} ·
        {{ user.nickname }}</el-tag
      >
    </div>
    <el-form
      label-position="top"
      :disabled="action.busy.value"
      @submit.prevent="save"
    >
      <el-form-item label="统一新密码" required
        ><el-input
          v-model="password"
          aria-label="统一新密码"
          type="password"
          show-password
          autocomplete="new-password"
          :maxlength="128"
        />
        <p class="field-help">
          8—128 字节；中文通常每字 3 字节。密码只用于本次提交。
        </p></el-form-item
      >
      <el-form-item
        label="再次输入新密码"
        required
        :error="
          confirmPassword && confirmPassword !== password
            ? '两次输入的密码不一致'
            : ''
        "
        ><el-input
          v-model="confirmPassword"
          aria-label="再次输入新密码"
          type="password"
          show-password
          autocomplete="new-password"
          :maxlength="128"
      /></el-form-item>
      <el-checkbox v-model="confirmed"
        >已核对所选用户，确认重置密码并使其重新登录</el-checkbox
      >
    </el-form>
    <el-alert
      v-if="action.error.value"
      :title="action.error.value"
      type="error"
      :closable="false"
      class="mt-4"
    />
    <template #footer
      ><el-button :disabled="action.busy.value" @click="open = false"
        >取消</el-button
      ><el-button
        type="primary"
        :disabled="!valid"
        :loading="action.busy.value"
        @click="save"
        >确认重置 {{ users.length }} 人</el-button
      ></template
    >
  </el-dialog>
</template>
<style scoped>
.reset-users {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 160px;
  overflow: auto;
  margin: 12px 0 22px;
}
</style>
