<script setup lang="ts">
import { computed, ref, shallowRef, watch, useTemplateRef } from "vue";
import { ElMessage } from "element-plus";
import { post } from "../../api/client";
import { can, useSession } from "../../stores/session";
import { useAction } from "../../composables/useAction";
import type { RecordData, FormField } from "../../domain/types";
import SchemaForm from "../../components/SchemaForm.vue";
import ImageUpload from "../../components/ImageUpload.vue";
import UserPasswordViewer from "./UserPasswordViewer.vue";
const { isSuper } = useSession();
const props = defineProps<{
  modelValue: boolean;
  user: RecordData | null;
  batch?: boolean;
  passwordOnly?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [];
}>();
const open = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});
const draft = ref<RecordData>({}),
  resetPassword = shallowRef(false),
  uploading = shallowRef(false);
const form = useTemplateRef<InstanceType<typeof SchemaForm>>("form");
const action = useAction();
watch(
  () => props.modelValue,
  (value) => {
    if (value) {
      createRequest = "";
      createPayload = "";
      draft.value = props.batch
        ? { prefix: "user", start: 1, count: 10, password: "" }
        : {
            ...props.user,
            username: props.user?.account || "",
            nickname: props.user?.nickname || "",
            avatar_url: props.user?.avatar_url || "",
            password: "",
          };
      resetPassword.value = !!props.passwordOnly;
      action.error.value = "";
    }
  },
);
let createRequest = "",
  createPayload = "";
const bytes = (value: unknown) =>
  new TextEncoder().encode(String(value || "")).length;
const passwordError = (value: unknown) =>
  bytes(value) < 8 || bytes(value) > 128
    ? "密码须为 8—128 字节（中文通常每字 3 字节）"
    : "";
const fields = computed<FormField[]>(() =>
  props.batch
    ? [
        {
          key: "prefix",
          label: "账号前缀",
          required: true,
          maxLength: 24,
          help: "以字母开头，可使用字母、数字和下划线。",
          validate: (value) =>
            /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(String(value || ""))
              ? ""
              : "请输入以字母开头的 1—24 位账号前缀",
        },
        {
          key: "start",
          label: "起始编号",
          type: "number",
          min: 1,
          max: 999999999,
          validate: (value) =>
            Number.isInteger(value) && value >= 1 && value <= 999999999
              ? ""
              : "起始编号须为 1—999999999 的整数",
          required: true,
        },
        {
          key: "count",
          label: "创建数量",
          type: "number",
          min: 1,
          max: 100,
          validate: (value) =>
            Number.isInteger(value) && value >= 1 && value <= 100
              ? ""
              : "创建数量须为 1—100 的整数",
          required: true,
        },
        {
          key: "password",
          label: "初始密码",
          type: "password",
          required: true,
          wide: true,
          help: "8—128 字节。创建结果不回显密码，请妥善分发初始密码。",
          validate: passwordError,
        },
      ]
    : props.passwordOnly
      ? [
          {
            key: "password",
            label: "新密码",
            type: "password",
            required: true,
            wide: true,
            validate: passwordError,
            help: "8—128 字节。保存后旧密码失效，所有现有登录会话下线。",
          },
        ]
      : [
          {
            key: "username",
            label: "账号",
            disabled: !!props.user,
            required: true,
            help: props.user
              ? undefined
              : "5—10 位，以字母开头，包含字母和数字。",
          },
          ...(props.user
            ? [{ key: "public_id", label: "公开用户 ID", disabled: true }]
            : []),
          { key: "nickname", label: "昵称", required: true, maxLength: 32 },
          ...(!props.user || resetPassword.value
            ? [
                {
                  key: "password",
                  label: props.user ? "新密码" : "初始密码",
                  type: "password" as const,
                  required: true,
                  wide: true,
                  help: props.user
                    ? "保存后旧密码失效，原登录会话下线；已启用密码加密记录时，可查看新密码。"
                    : "8—16 字节，包含字母和数字，不含空格。",
                },
              ]
            : []),
        ],
);
async function save() {
  if (!can("users", true) || uploading.value || !(await form.value?.validate()))
    return;
  await action.run(async () => {
    const value = { ...draft.value };
    if (props.batch) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(value.prefix) ||
        (value.prefix + String(value.start + value.count - 1)).length > 32
      )
        throw new Error("账号前缀或生成账号长度不合法");
      if (passwordError(value.password))
        throw new Error(passwordError(value.password));
      const payload = JSON.stringify(value);
      if (payload !== createPayload) {
        createPayload = payload;
        createRequest = crypto.randomUUID();
      }
      const result = await post("/admin/users/batch", {
        ...value,
        request_id: createRequest,
      });
      ElMessage.success(`成功创建 ${result.count} 个用户`);
    } else if (props.passwordOnly) {
      if (passwordError(value.password))
        throw new Error(passwordError(value.password));
      await post("/admin/users/edit", {
        user_id: props.user?.id,
        password: value.password,
      });
      ElMessage.success("密码已修改，该用户原登录会话已失效");
    } else {
      if (Array.from(String(value.nickname).trim()).length < 2)
        throw new Error("昵称需要 2—32 个字符");
      if (
        !props.user &&
        (!/^[A-Za-z][A-Za-z0-9]{4,9}$/.test(value.username) ||
          !/[0-9]/.test(value.username))
      )
        throw new Error("账号需要 5—10 位，以字母开头，包含字母和数字");
      if (!props.user || resetPassword.value) {
        const length = bytes(value.password);
        if (
          length < 8 ||
          length > (props.user ? 128 : 16) ||
          (!props.user &&
            (!/[A-Za-z]/.test(value.password) ||
              !/[0-9]/.test(value.password) ||
              /\s/.test(value.password)))
        )
          throw new Error("密码长度或格式不合法，请包含字母和数字且不含空格");
      } else delete value.password;
      // Existing avatar URLs are display-only; send only a newly uploaded media reference.
      if (!String(value.avatar_url).startsWith("pulse-media:"))
        delete value.avatar_url;
      await post(props.user ? "/admin/users/edit" : "/admin/users", {
        ...value,
        user_id: props.user?.id,
        request_id: crypto.randomUUID(),
      });
      ElMessage.success(props.user ? "用户资料已更新" : "用户已创建");
    }
    draft.value.password = "";
    open.value = false;
    emit("saved");
  });
}
</script>
<template>
  <el-drawer
    v-model="open"
    :title="
      batch
        ? '批量创建用户'
        : passwordOnly
          ? '修改密码'
          : user
            ? '编辑用户'
            : '新增用户'
    "
    size="620px"
    :close-on-click-modal="!action.busy.value && !uploading"
    :close-on-press-escape="!action.busy.value && !uploading"
    :show-close="!action.busy.value && !uploading"
    destroy-on-close
    @closed="draft = {}"
  >
    <div v-if="!batch && !passwordOnly" class="mb-6">
      <p class="mb-3 text-sm muted">用户头像</p>
      <ImageUpload
        v-model="draft.avatar_url"
        path="/admin/users/avatar"
        avatar
        :max-m-b="5"
        :disabled="action.busy.value"
        @busy="uploading = $event"
      />
    </div>
    <UserPasswordViewer
      v-if="user && isSuper && !batch"
      :user-id="Number(user.id)"
      :active="modelValue"
    />
    <el-alert
      v-else-if="user"
      title="可设置新密码；查看已留存的当前密码仅限超级管理员。"
      type="info"
      :closable="false"
      class="mb-5"
    />
    <p v-if="batch && draft.prefix" class="field-help mb-3">
      账号范围：{{ draft.prefix }}{{ draft.start }} — {{ draft.prefix
      }}{{ Number(draft.start) + Number(draft.count) - 1 }}
    </p>
    <SchemaForm
      ref="form"
      v-model="draft"
      :fields="fields"
      :disabled="action.busy.value"
    />
    <el-checkbox
      v-if="user && !batch && !passwordOnly"
      v-model="resetPassword"
      :disabled="action.busy.value"
      @change="draft.password = ''"
      >修改此用户的密码</el-checkbox
    >
    <el-alert
      v-if="action.error.value"
      :title="action.error.value"
      type="error"
      :closable="false"
      show-icon
      class="mt-5"
    />
    <template #footer
      ><el-button
        :disabled="action.busy.value || uploading"
        @click="open = false"
        >取消</el-button
      ><el-button
        type="primary"
        :loading="action.busy.value"
        :disabled="uploading || !can('users', true)"
        @click="save"
        >{{ batch ? "创建用户" : "保存" }}</el-button
      ></template
    >
  </el-drawer>
</template>
