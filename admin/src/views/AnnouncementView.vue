<script setup lang="ts">
import { shallowRef, onMounted, onBeforeUnmount, useTemplateRef } from "vue";
import { get, post } from "../api/client";
import { can } from "../stores/session";
import { useAction } from "../composables/useAction";
import type { FormField, RecordData } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import SchemaForm from "../components/SchemaForm.vue";
import ArtIcon from "../components/ArtIcon.vue";
const draft = shallowRef<RecordData>({
    enabled: false,
    title: "",
    content: "",
  }),
  loading = shallowRef(false),
  error = shallowRef(""),
  action = useAction();
const form = useTemplateRef<InstanceType<typeof SchemaForm>>("form"),
  controller = new AbortController();
const fields: FormField[] = [
  {
    key: "enabled",
    label: "启用启动公告",
    type: "switch",
    wide: true,
    help: "关闭后不弹窗，也不显示首页公告栏。",
  },
  {
    key: "title",
    label: "公告标题",
    required: true,
    maxLength: 32,
    wide: true,
  },
  {
    key: "content",
    label: "公告正文",
    type: "textarea",
    required: true,
    maxLength: 4000,
    wide: true,
    help: "以纯文字展示，使用 {app_name} 自动替换为应用名称。",
  },
];
async function load() {
  loading.value = true;
  error.value = "";
  try {
    draft.value = await get("/admin/announcement", controller.signal);
  } catch (e: any) {
    if (e.name !== "AbortError") error.value = e.message;
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!can("announcement", true) || !(await form.value?.validate())) return;
  await action.run(async () => {
    draft.value = await post("/admin/announcement", {
      ...draft.value,
      request_id: crypto.randomUUID(),
    });
  }, "公告已保存，用户下次打开应用时生效");
}
onMounted(load);
onBeforeUnmount(() => controller.abort());
</script>
<template>
  <PageHeader title="通知公告"
    ><el-button :loading="loading" @click="load">重新加载</el-button
    ><el-button
      v-if="can('announcement', true)"
      type="primary"
      :loading="action.busy.value"
      :disabled="loading"
      @click="save"
      >保存公告</el-button
    ></PageHeader
  ><el-alert v-if="error" :title="error" type="error" class="mb-5" />
  <div class="announcement-layout">
    <section v-loading="loading" class="art-card section-card">
      <div class="section-heading">
        <div>
          <h2>启动公告</h2>
          <p>下次打开应用时读取最新内容</p>
        </div>
        <el-tag :type="draft.enabled ? 'success' : 'info'" round>{{
          draft.enabled ? "已启用" : "已停用"
        }}</el-tag>
      </div>
      <SchemaForm
        ref="form"
        v-model="draft"
        :fields="fields"
        :disabled="!can('announcement', true) || action.busy.value"
      />
      <p class="field-help">更新时间：{{ draft.updated_at || "尚未保存" }}</p>
    </section>
    <section class="art-card section-card preview-panel">
      <div class="section-heading">
        <div>
          <h2>用户端预览</h2>
        </div>
      </div>
      <div class="phone-frame">
        <div class="phone-island" />
        <div class="phone-background">
          <div class="notice-preview">
            <div class="notice-symbol"><ArtIcon name="Bell" :size="32" /></div>
            <h3>{{ draft.title || "公告标题" }}</h3>
            <p>
              {{
                draft.content?.replaceAll("{app_name}", "脉冲即时通讯") ||
                "在左侧填写需要通知用户的内容。"
              }}
            </p>
            <span class="notice-ok">我知道了</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
<style scoped>
.announcement-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr);
  gap: 24px;
}
.preview-panel {
  min-height: 560px;
}
.phone-frame {
  width: 250px;
  height: 445px;
  border: 5px solid var(--hairline);
  border-radius: 35px;
  margin: 20px auto 0;
  position: relative;
  overflow: hidden;
  background: var(--page-bg);
}
.phone-island {
  width: 75px;
  height: 17px;
  background: var(--hairline);
  border-radius: 0 0 12px 12px;
  margin: 0 auto;
}
.phone-background {
  display: grid;
  place-items: center;
  height: 400px;
  padding: 17px;
}
.notice-preview {
  background: var(--surface);
  box-shadow: 0 6px 22px #2034570c;
  border-radius: 16px;
  padding: 23px 20px;
  text-align: center;
  width: 100%;
}
.notice-symbol {
  width: 65px;
  height: 65px;
  border-radius: 20px;
  background: var(--el-color-primary-light-9);
  color: var(--main-color);
  display: grid;
  place-items: center;
  margin: 0 auto 15px;
}
.notice-preview h3 {
  font-size: 15px;
  font-weight: 600;
}
.notice-preview p {
  white-space: pre-wrap;
  font-size: 11px;
  line-height: 1.9;
  color: var(--muted);
  max-height: 170px;
  overflow: auto;
  text-align: left;
  margin: 12px 0 20px;
  word-break: break-word;
}
.notice-ok {
  display: block;
  background: var(--main-color);
  color: #fff;
  font-size: 12px;
  border-radius: 7px;
  padding: 9px;
}
@media (max-width: 1050px) {
  .announcement-layout {
    grid-template-columns: 1fr;
  }
}
</style>
