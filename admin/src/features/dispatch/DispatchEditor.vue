<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount } from "vue";
import { get, post, query } from "../../api/client";
import { can } from "../../stores/session";
import { useAction } from "../../composables/useAction";
import type { RecordData } from "../../domain/types";
import EntitySelect from "../../components/EntitySelect.vue";
import DispatchStepEditor from "./DispatchStepEditor.vue";
import ArtIcon from "../../components/ArtIcon.vue";
const props = defineProps<{
  modelValue: boolean;
  task: RecordData | null;
  readonly?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [];
}>();
const open = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});
const draft = ref<RecordData>({ steps: [], recipient_ids: [] }),
  loading = shallowRef(false),
  error = shallowRef(""),
  uploads = shallowRef(0),
  action = useAction();
const disabled = computed(
  () =>
    !!props.readonly ||
    !can("dispatch-tasks", true) ||
    action.busy.value ||
    loading.value,
);
let controller: AbortController | undefined,
  sequence = 0;
function beijingInput(value: Date | string) {
  const date = new Date(value),
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  const get = (key: string) => parts.find((p) => p.type === key)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
const newStep = () => ({
  _key: crypto.randomUUID(),
  type: "text",
  text: "",
  image_url: "",
  delay_seconds: 0,
});
watch(
  () => props.modelValue,
  async (value) => {
    controller?.abort();
    const id = ++sequence;
    if (!value) return;
    uploads.value = 0;
    action.error.value = "";
    error.value = "";
    draft.value = {
      id: 0,
      name: "",
      sender_id: null,
      recipient_type: "group",
      recipient_ids: [],
      trigger_type: "once",
      execute_at: beijingInput(new Date(Date.now() + 15 * 60000)),
      cron_expression: "",
      enabled: true,
      steps: [newStep()],
    };
    if (props.task) {
      controller = new AbortController();
      loading.value = true;
      try {
        const result = await get(
          query("/admin/dispatch-tasks/detail", { id: props.task.id }),
          controller.signal,
        );
        if (id !== sequence) return;
        const task = { ...props.task, ...result.task };
        draft.value = {
          ...draft.value,
          ...task,
          name: task.name || props.task.name,
          recipient_ids:
            task.recipient_ids ||
            task.recipients?.map((r: RecordData) => Number(r.id)) ||
            [],
          execute_at: task.execute_at
            ? beijingInput(task.execute_at)
            : draft.value.execute_at,
          steps: task.steps.map((step: RecordData) => ({
            ...newStep(),
            ...step,
          })),
        };
      } catch (e: any) {
        if (id === sequence && e.name !== "AbortError") error.value = e.message;
      } finally {
        if (id === sequence) loading.value = false;
      }
    }
  },
);
function updateStep(index: number, step: RecordData) {
  draft.value.steps[index] = step;
}
function move(index: number, offset: number) {
  const next = index + offset;
  if (next < 0 || next >= draft.value.steps.length) return;
  const steps = [...draft.value.steps];
  [steps[index], steps[next]] = [steps[next], steps[index]];
  draft.value.steps = steps;
}
async function save() {
  if (disabled.value || uploads.value) return;
  await action.run(async () => {
    if (!String(draft.value.name || "").trim())
      throw new Error("请填写任务名称");
    if (!draft.value.sender_id) throw new Error("请选择发送者");
    if (!draft.value.recipient_ids.length) throw new Error("请选择接收对象");
    if (
      draft.value.trigger_type === "once" &&
      (!draft.value.execute_at ||
        new Date(draft.value.execute_at + "+08:00").getTime() <= Date.now())
    )
      throw new Error("执行时间需要晚于当前北京时间");
    if (
      draft.value.trigger_type === "cron" &&
      String(draft.value.cron_expression).trim().split(/\s+/).length !== 5
    )
      throw new Error("请填写 5 字段 Cron 表达式");
    const steps = draft.value.steps.map((step: RecordData, index: number) => {
      if (step.type !== "image" && !String(step.text || "").trim())
        throw new Error(`请填写第 ${index + 1} 步的文字`);
      if (
        step.type !== "text" &&
        !String(step.image_url || "").startsWith("pulse-media:")
      )
        throw new Error(`请上传第 ${index + 1} 步的图片`);
      if (
        !Number.isInteger(step.delay_seconds) ||
        step.delay_seconds < 0 ||
        step.delay_seconds > 86400
      )
        throw new Error(`第 ${index + 1} 步延迟需要为 0—86400 的整数秒`);
      return {
        type: step.type,
        text: step.type === "image" ? "" : step.text,
        image_url: step.type === "text" ? "" : step.image_url,
        delay_seconds: step.delay_seconds,
      };
    });
    await post("/admin/dispatch-tasks", {
      ...draft.value,
      steps,
      request_id: crypto.randomUUID(),
    });
    open.value = false;
    emit("saved");
  }, "分发任务已保存");
}
onBeforeUnmount(() => {
  sequence++;
  controller?.abort();
});
</script>
<template>
  <el-drawer
    v-model="open"
    :title="readonly ? '分发任务详情' : task ? '编辑分发任务' : '新增分发任务'"
    size="800px"
    :close-on-click-modal="!action.busy.value && !uploads"
    :close-on-press-escape="!action.busy.value && !uploads"
    :show-close="!action.busy.value && !uploads"
    destroy-on-close
    ><div v-loading="loading">
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        class="mb-5"
      /><el-form label-position="top" :disabled="disabled"
        ><el-form-item label="任务名称" required
          ><el-input
            v-model="draft.name"
            maxlength="120"
            placeholder="为这次分发起个名称"
        /></el-form-item>
        <div class="config-grid">
          <el-form-item label="发送者" required
            ><EntitySelect
              v-model="draft.sender_id"
              kind="sender"
              :disabled="disabled"
              :initial="
                draft.sender_id
                  ? [
                      {
                        id: draft.sender_id,
                        name:
                          draft.sender?.name ||
                          draft.sender?.nickname ||
                          '#' + draft.sender_id,
                      },
                    ]
                  : []
              " /></el-form-item
          ><el-form-item label="接收类型"
            ><el-select
              v-model="draft.recipient_type"
              @change="draft.recipient_ids = []"
              ><el-option label="群组 / 频道" value="group" /><el-option
                label="用户"
                value="user" /></el-select
          ></el-form-item>
        </div>
        <el-form-item label="接收对象" required
          ><EntitySelect
            v-model="draft.recipient_ids"
            :kind="draft.recipient_type === 'user' ? 'user' : 'group'"
            multiple
            :disabled="disabled"
            :initial="draft.recipients || []"
          />
          <p class="field-help">
            最多 100 个对象；发送时仍执行账号状态、拉黑、隐私和会话权限校验。
          </p></el-form-item
        >
        <div class="config-grid">
          <el-form-item label="触发方式"
            ><el-select v-model="draft.trigger_type"
              ><el-option label="指定时间执行" value="once" /><el-option
                label="Cron 定时执行"
                value="cron" /></el-select></el-form-item
          ><el-form-item
            v-if="draft.trigger_type === 'once'"
            label="执行时间（北京时间）"
            required
            ><el-date-picker
              v-model="draft.execute_at"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm:ss"
              placeholder="选择北京时间"
              style="width: 100%" /></el-form-item
          ><el-form-item v-else label="Cron 表达式（北京时间）" required
            ><el-input
              v-model="draft.cron_expression"
              placeholder="0 9 * * *"
              maxlength="120"
          /></el-form-item>
        </div>
        <el-form-item label="启用任务"
          ><el-switch v-model="draft.enabled" /></el-form-item></el-form
      ><el-divider />
      <div class="section-heading">
        <div>
          <h3>发送步骤</h3>
          <p>按顺序执行，最多 100 步</p>
        </div>
        <el-button
          v-if="!readonly"
          :disabled="disabled || draft.steps.length >= 100"
          @click="draft.steps.push(newStep())"
          ><ArtIcon name="Plus" :size="14" />添加步骤</el-button
        >
      </div>
      <DispatchStepEditor
        v-for="(step, index) in draft.steps"
        :key="step._key"
        :model-value="step"
        :index="Number(index)"
        :total="draft.steps.length"
        :disabled="disabled"
        @update:model-value="updateStep(Number(index), $event)"
        @move="move(Number(index), $event)"
        @remove="draft.steps.splice(Number(index), 1)"
        @busy="uploads = Math.max(0, uploads + ($event ? 1 : -1))"
      /><el-alert
        v-if="action.error.value"
        :title="action.error.value"
        type="error"
        :closable="false"
      />
      <p v-if="uploads" class="field-help">
        {{ uploads }} 张图片正在上传处理，完成后可保存。
      </p>
    </div>
    <template #footer
      ><el-button
        :disabled="action.busy.value || !!uploads"
        @click="open = false"
        >{{ readonly ? "关闭" : "取消" }}</el-button
      ><el-button
        v-if="!readonly"
        type="primary"
        :disabled="disabled || !!uploads || !!error"
        :loading="action.busy.value"
        @click="save"
        >保存任务</el-button
      ></template
    ></el-drawer
  >
</template>
