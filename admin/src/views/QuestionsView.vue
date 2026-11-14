<script setup lang="ts">
import { useTemplateRef, shallowRef } from "vue";
import { ElMessageBox } from "element-plus";
import { download, upload, query, mediaURL } from "../api/client";
import { can } from "../stores/session";
import { useAction } from "../composables/useAction";
import CrudPage from "../components/CrudPage.vue";
import type { CrudDefinition } from "../components/CrudPage.vue";
const input = useTemplateRef<HTMLInputElement>("importFile"),
  action = useAction(),
  lastImport = shallowRef("");
const definition: CrudDefinition = {
  key: "question-bank",
  title: "题库管理",
  endpoint: "/admin/work-questions",
  deleteEndpoint: "/admin/work-questions/delete",
  defaults: { question_uuid: "", image_url: "", correct_answer: "1" },
  filters: [
    { key: "uuid", label: "题目编号" },
    {
      key: "answer",
      label: "标准答案",
      type: "select",
      options: [
        { value: "1", label: "对" },
        { value: "0", label: "错" },
      ],
    },
  ],
  fields: (row) => [
    {
      key: "question_uuid",
      label: "题目编号",
      required: true,
      disabled: !!row.id,
      maxLength: 36,
      help: "使用 UUID 格式，例如 123e4567-e89b-42d3-a456-426614174000。",
      wide: true,
    },
    {
      key: "image_url",
      label: "题目图片地址",
      maxLength: 2048,
      wide: true,
      help: "可填写已有题目图片地址，或在下面上传新图片。",
    },
    { key: "image_url", label: "上传题目图片", type: "image", wide: true },
    {
      key: "correct_answer",
      label: "标准答案",
      type: "select",
      required: true,
      options: [
        { value: "1", label: "对" },
        { value: "0", label: "错" },
      ],
    },
  ],
  columns: [
    { key: "question_uuid", label: "题目编号", minWidth: 200 },
    { key: "image_url", label: "图片", minWidth: 160 },
    {
      key: "correct_answer",
      label: "标准答案",
      minWidth: 130,
      format: (r) => (r.correct_answer ? "对" : "错"),
      tag: (r) => (r.correct_answer ? "success" : "danger"),
    },
    { key: "created_at", label: "创建时间", minWidth: 180 },
    { key: "updated_at", label: "更新时间", minWidth: 180 },
  ],
  prepare: (row) => ({
    ...row,
    question_uuid: row.question_uuid || crypto.randomUUID(),
    correct_answer: row.id
      ? row.correct_answer
        ? "1"
        : "0"
      : row.correct_answer,
  }),
  validate(row) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        row.question_uuid,
      )
    )
      throw new Error("题目编号需要为 UUID 格式");
    if (!row.image_url) throw new Error("请上传题目图片或填写有效地址");
  },
};
async function importFile(event: Event, reload: () => Promise<void>) {
  const node = event.target as HTMLInputElement,
    file = node.files?.[0];
  node.value = "";
  if (!file || !can("question-bank", true)) return;
  await action.run(async () => {
    const result = await upload(
      "/admin/work-questions/import",
      file,
      AbortSignal.timeout(120000),
    );
    lastImport.value = `新增 ${result.created || 0} 条，更新 ${result.updated || 0} 条，失败 ${result.errors?.length || 0} 条`;
    if (result.errors?.length)
      await ElMessageBox.alert(
        result.errors
          .slice(0, 50)
          .map((r: any) => `第 ${r.row} 行：${r.message}`)
          .join("\n"),
        "导入结果",
        { confirmButtonText: "知道了", customClass: "import-result" },
      );
    await reload();
  }, "题库导入完成");
}
</script>
<template>
  <CrudPage :definition="definition"
    ><template #toolbar="{ reload, filters }"
      ><input
        ref="importFile"
        type="file"
        accept=".xlsx,.xls,.csv"
        class="hidden"
        @change="importFile($event, reload)"
      /><el-button
        v-if="can('question-bank', true)"
        :loading="action.busy.value"
        @click="input?.click()"
        >导入</el-button
      ><el-button
        :disabled="action.busy.value"
        @click="
          action.run(() =>
            download(
              query('/admin/work-questions/export', filters),
              '题库.xlsx',
            ),
          )
        "
        >导出</el-button
      ><el-button
        :disabled="action.busy.value"
        @click="
          action.run(() =>
            download('/admin/work-questions/template', '题库导入模板.xlsx'),
          )
        "
        >模板</el-button
      ></template
    ><template #image_url="{ row }"
      ><el-image
        v-if="mediaURL(row.image_url)"
        :src="mediaURL(row.image_url)"
        :preview-src-list="[mediaURL(row.image_url)]"
        preview-teleported
        fit="contain"
        class="question-thumb"
        ><template #error>图片不可用</template></el-image
      ><span v-else class="muted">无图片</span></template
    ></CrudPage
  >
  <p v-if="lastImport" class="field-help">最近导入：{{ lastImport }}</p>
</template>
<style scoped>
.question-thumb {
  width: 110px;
  height: 65px;
  border-radius: 7px;
}
</style>
