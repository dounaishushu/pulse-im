<script setup lang="ts">
import { shallowRef, watch, onBeforeUnmount } from "vue";
import { get, query } from "../../api/client";
import { can } from "../../stores/session";
import { useAction, confirmAction } from "../../composables/useAction";
import type { RecordData } from "../../domain/types";
const props = defineProps<{ task: RecordData | null }>();
const emit = defineEmits<{ close: [] }>();
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
const date = shallowRef(today()),
  code = shallowRef(""),
  action = useAction();
let controller: AbortController | undefined;
async function load(regenerate = false) {
  if (!props.task || !can("task-config", true)) return;
  if (
    regenerate &&
    !(await confirmAction("确认重新生成所选日期的任务验证码？原验证码将失效。"))
  )
    return;
  const id = props.task.id;
  controller?.abort();
  controller = new AbortController();
  await action.run(async () => {
    const result = await get(
      query("/admin/work-tasks/code", {
        task_id: id,
        date: date.value,
        regenerate: regenerate ? "1" : "0",
      }),
      controller!.signal,
    );
    if (props.task?.id === id) code.value = result.code;
  });
}
watch(
  () => props.task,
  (value) => {
    controller?.abort();
    code.value = "";
    date.value = today();
    if (value) void load();
  },
);
let previousDate = today();
const rollover = setInterval(() => {
  const next = today();
  if (next !== previousDate) {
    if (date.value === previousDate) {
      date.value = next;
      void load();
    }
    previousDate = next;
  }
}, 30000);
onBeforeUnmount(() => {
  clearInterval(rollover);
  controller?.abort();
});
</script>
<template>
  <el-dialog
    :model-value="!!task"
    title="每日任务验证码"
    width="470px"
    @close="
      controller?.abort();
      emit('close');
    "
    ><p class="mb-5">{{ task?.name }}</p>
    <el-form label-position="top"
      ><el-form-item label="日期（北京时间）"
        ><el-date-picker
          v-model="date"
          type="date"
          value-format="YYYY-MM-DD"
          :clearable="false"
          @change="load()" /></el-form-item
    ></el-form>
    <div class="task-code" aria-live="polite">
      {{ action.busy.value ? "读取中…" : code || "暂无验证码" }}
    </div>
    <p v-if="action.error.value" class="field-help">{{ action.error.value }}</p>
    <template #footer
      ><el-button @click="emit('close')">关闭</el-button
      ><el-button
        type="primary"
        :loading="action.busy.value"
        @click="load(true)"
        >重新生成</el-button
      ></template
    ></el-dialog
  >
</template>
<style scoped>
.task-code {
  padding: 27px 15px;
  background: var(--el-color-primary-light-9);
  color: var(--main-color);
  font-size: 34px;
  letter-spacing: 7px;
  text-align: center;
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
}
</style>
