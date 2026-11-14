<script setup lang="ts">
import { computed, ref, shallowRef, watch, useTemplateRef } from "vue";
import { ElMessage } from "element-plus";
import { post } from "../../api/client";
import { can } from "../../stores/session";
import { useAction } from "../../composables/useAction";
import type { RecordData, FormField } from "../../domain/types";
import SchemaForm from "../../components/SchemaForm.vue";
import ImageUpload from "../../components/ImageUpload.vue";
const props = defineProps<{
  modelValue: boolean;
  user: RecordData | null;
  batch?: boolean;
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
      draft.value = props.batch
        ? { prefix: "user", start: 1, count: 10, password: "" }
        : {
            ...props.user,
            username: props.user?.account || "",
            nickname: props.user?.nickname || "",
            avatar_url: props.user?.avatar_url || "",
            password: "",
          };
      resetPassword.value = false;
      action.error.value = "";
    }
  },
);
const fields = computed<FormField[]>(() =>
  props.batch
    ? [
        { key: "prefix", label: "账号前缀", required: true, maxLength: 24 },
        {
          key: "start",
          label: "起始编号",
          type: "number",
          min: 1,
          required: true,
        },
        {
          key: "count",
          label: "创建数量",
          type: "number",
          min: 1,
          max: 100,
          required: true,
        },
        {
          key: "password",
          label: "初始密码",
          type: "password",
          required: true,
          wide: true,
          help: "创建结果中不会回显密码，请妥善分发初始密码。",
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
                  ? "保存后旧密码失效，原密码无法查看。"
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
      if (value.password.length < 8 || value.password.length > 128)
        throw new Error("密码长度需要 8—128 位");
      const result = await post("/admin/users/batch", {
        ...value,
        request_id: crypto.randomUUID(),
      });
      ElMessage.success(`成功创建 ${result.count} 个用户`);
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
        const bytes = new TextEncoder().encode(value.password).length;
        if (
          bytes < 8 ||
          bytes > (props.user ? 128 : 16) ||
          !/[A-Za-z]/.test(value.password) ||
          !/[0-9]/.test(value.password) ||
          /\s/.test(value.password)
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
    :title="batch ? '批量创建用户' : user ? '编辑用户' : '新增用户'"
    size="620px"
    :close-on-click-modal="!action.busy.value && !uploading"
    :close-on-press-escape="!action.busy.value && !uploading"
    :show-close="!action.busy.value && !uploading"
    destroy-on-close
    @closed="draft = {}"
  >
    <div v-if="!batch" class="mb-6">
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
    <SchemaForm
      ref="form"
      v-model="draft"
      :fields="fields"
      :disabled="action.busy.value"
    />
    <el-checkbox
      v-if="user && !batch"
      v-model="resetPassword"
      :disabled="action.busy.value"
      @change="draft.password = ''"
      >重置此用户的密码</el-checkbox
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
