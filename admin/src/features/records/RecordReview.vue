<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount } from "vue";
import { get, post, query, mediaURL } from "../../api/client";
import { can } from "../../stores/session";
import { useAction } from "../../composables/useAction";
import { labelStatus, tagStatus, formatTime } from "../../domain/catalog";
import type { RecordData } from "../../domain/types";
const props = defineProps<{ recordId: number | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const detail = shallowRef<RecordData | null>(null),
  loading = shallowRef(false),
  error = shallowRef(""),
  index = shallowRef(1),
  note = shallowRef(""),
  results = ref<Record<string, boolean | null>>({}),
  action = useAction();
let controller: AbortController | undefined,
  sequence = 0,
  submission: { fingerprint: string; id: string } | null = null;
const current = computed(() => detail.value?.questions?.[index.value - 1]);
const editable = computed(
  () =>
    detail.value?.record.status === "pending_review" &&
    can("task-records", true) &&
    !action.busy.value,
);
const completed = computed(
  () =>
    Object.values(results.value).filter((value) => typeof value === "boolean")
      .length,
);
function answer(value: unknown) {
  return value === true ? "对" : value === false ? "错" : "未作答";
}
function duration(seconds: number) {
  const value = Math.max(0, Number(seconds || 0));
  return `${Math.floor(value / 3600)}小时 ${Math.floor((value % 3600) / 60)}分 ${Math.floor(value % 60)}秒`;
}
async function load() {
  controller?.abort();
  controller = new AbortController();
  const id = ++sequence;
  detail.value = null;
  error.value = "";
  loading.value = true;
  submission = null;
  try {
    const result = await get(
      query("/admin/work-records/detail", { id: props.recordId }),
      controller.signal,
    );
    if (id !== sequence) return;
    detail.value = result;
    index.value = 1;
    note.value = result.record.review_note || "";
    results.value = Object.fromEntries(
      result.questions.map((q: RecordData) => [
        q.question_uuid,
        typeof q.reviewed_correct === "boolean" ? q.reviewed_correct : null,
      ]),
    );
  } catch (e: any) {
    if (id === sequence && e.name !== "AbortError") error.value = e.message;
  } finally {
    if (id === sequence) loading.value = false;
  }
}
watch(
  () => props.recordId,
  (id) => {
    if (id) void load();
    else {
      sequence++;
      controller?.abort();
      detail.value = null;
    }
  },
);
function automatic() {
  if (!editable.value) return;
  results.value = Object.fromEntries(
    detail.value!.questions.map((q: RecordData) => [
      q.question_uuid,
      typeof q.answer === "boolean" && typeof q.correct_answer === "boolean"
        ? q.answer === q.correct_answer
        : null,
    ]),
  );
}
async function save() {
  if (!editable.value || !detail.value) return;
  await action.run(async () => {
    if (
      !detail.value!.questions.length ||
      detail.value!.questions.some(
        (q: RecordData) => typeof results.value[q.question_uuid] !== "boolean",
      )
    )
      throw new Error("请完成全部题目的批改后再保存");
    const payload = {
      record_id: props.recordId,
      results: results.value,
      note: note.value,
    };
    const fingerprint = JSON.stringify(payload);
    if (!submission || submission.fingerprint !== fingerprint)
      submission = { fingerprint, id: "review-" + crypto.randomUUID() };
    await post("/admin/work-records/review", {
      ...payload,
      request_id: submission.id,
    });
    emit("saved");
    emit("close");
  }, "作业批改已保存");
}
onBeforeUnmount(() => {
  sequence++;
  controller?.abort();
});
</script>
<template>
  <el-drawer
    :model-value="!!recordId"
    title="作业详情与批改"
    size="860px"
    :close-on-click-modal="!action.busy.value"
    :close-on-press-escape="!action.busy.value"
    :show-close="!action.busy.value"
    destroy-on-close
    @close="emit('close')"
    ><div v-loading="loading" class="review-content">
      <el-alert v-if="error" :title="error" type="error" :closable="false"
        ><el-button link type="primary" @click="load"
          >重新加载</el-button
        ></el-alert
      ><template v-if="detail"
        ><div class="record-heading">
          <div>
            <h2>
              {{
                detail.record.task_name || detail.record.task_key || "作业记录"
              }}
            </h2>
            <p>
              {{
                detail.record.nickname ||
                detail.record.username ||
                "#" + detail.record.user_id
              }}
              ·
              {{
                detail.record.employee_type === "formal"
                  ? "正式员工"
                  : "实习员工"
              }}
            </p>
          </div>
          <el-tag :type="tagStatus(detail.record.status)" round>{{
            labelStatus(detail.record.status)
          }}</el-tag>
        </div>
        <el-descriptions :column="2" border class="mb-6"
          ><el-descriptions-item label="记录编号"
            >#{{ detail.record.id }}</el-descriptions-item
          ><el-descriptions-item label="任务日期">{{
            detail.record.task_date
          }}</el-descriptions-item
          ><el-descriptions-item label="开始时间">{{
            formatTime(detail.record.start_at || detail.record.started_at)
          }}</el-descriptions-item
          ><el-descriptions-item label="完成时间">{{
            formatTime(detail.record.submitted_at || detail.record.reviewed_at)
          }}</el-descriptions-item
          ><el-descriptions-item label="完成耗时">{{
            duration(detail.record.duration_seconds)
          }}</el-descriptions-item
          ><el-descriptions-item label="本次工资"
            >¥
            {{
              Number(detail.record.wage || 0).toFixed(2)
            }}</el-descriptions-item
          ></el-descriptions
        >
        <div class="review-metrics">
          <div>
            <span>总题数</span
            ><strong>{{ detail.record.total_questions }}</strong>
          </div>
          <div>
            <span>答对</span
            ><strong class="text-emerald-500">{{
              detail.record.correct_count
            }}</strong>
          </div>
          <div>
            <span>答错</span
            ><strong class="text-red-400">{{
              detail.record.wrong_count
            }}</strong>
          </div>
          <div>
            <span>已批改</span
            ><strong>{{ completed }} / {{ detail.questions.length }}</strong>
          </div>
        </div>
        <template v-if="current"
          ><div class="question-header">
            <div>
              <h3>第 {{ index }} 题</h3>
              <p>{{ current.question_code || current.question_uuid }}</p>
            </div>
            <el-tag
              v-if="typeof results[current.question_uuid] === 'boolean'"
              :type="results[current.question_uuid] ? 'success' : 'danger'"
              >{{
                results[current.question_uuid] ? "批改正确" : "批改错误"
              }}</el-tag><el-tag v-else type="info">待判断</el-tag>
          </div>
          <div class="question-stage">
            <el-image
              v-if="mediaURL(current.image_url)"
              :src="mediaURL(current.image_url)"
              :preview-src-list="[mediaURL(current.image_url)]"
              preview-teleported
              fit="contain"
              class="review-image"
              ><template #error
                ><el-empty
                  description="题目图片无法加载"
                  :image-size="60" /></template></el-image
            ><el-empty v-else description="此题未提供图片" :image-size="60" />
          </div>
          <div class="answer-grid">
            <div>
              <span>用户答案</span><strong>{{ answer(current.answer) }}</strong>
            </div>
            <div>
              <span>标准答案</span
              ><strong>{{ answer(current.correct_answer) }}</strong>
            </div>
          </div>
          <div
            v-if="
              can('task-records', true) && detail.record.status !== 'reviewed'
            "
            class="review-choice"
          >
            <el-button
              :type="
                results[current.question_uuid] === true ? 'success' : 'default'
              "
              :disabled="!editable"
              @click="results[current.question_uuid] = true"
              >批改正确</el-button
            ><el-button
              :type="
                results[current.question_uuid] === false ? 'danger' : 'default'
              "
              :disabled="!editable"
              @click="results[current.question_uuid] = false"
              >批改错误</el-button
            >
          </div>
          <el-pagination
            v-model:current-page="index"
            :page-size="1"
            :total="detail.questions.length"
            layout="prev,pager,next,jumper"
            class="question-pagination" /></template
        ><el-empty v-else description="暂无题目" /><el-form
          class="mt-6"
          label-position="top"
          ><el-form-item label="批改备注"
            ><el-input
              v-model="note"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              :disabled="!editable" /></el-form-item></el-form
        ><el-alert
          v-if="action.error.value"
          :title="action.error.value"
          type="error"
          :closable="false"
      /></template>
    </div>
    <template #footer
      ><el-button :disabled="action.busy.value" @click="emit('close')"
        >关闭</el-button
      ><template
        v-if="
          detail?.record.status === 'pending_review' &&
          can('task-records', true)
        "
        ><el-button :disabled="!editable" @click="automatic"
          >按标准答案批改</el-button
        ><el-button
          type="primary"
          :loading="action.busy.value"
          :disabled="!editable"
          @click="save"
          >保存批改</el-button
        ></template
      ></template
    ></el-drawer
  >
</template>
<style scoped>
.review-content {
  min-height: 160px;
}
.record-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 25px;
}
.record-heading h2 {
  font-size: 20px;
  font-weight: 600;
}
.record-heading p {
  font-size: 12px;
  color: var(--muted);
  margin-top: 7px;
}
.review-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  padding: 18px 20px;
  background: var(--page-bg);
  border-radius: 10px;
  margin-bottom: 28px;
}
.review-metrics span {
  display: block;
  font-size: 11px;
  color: var(--muted);
}
.review-metrics strong {
  display: block;
  font-size: 22px;
  font-weight: 500;
  margin-top: 5px;
}
.question-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 17px;
}
.question-header h3 {
  font-size: 15px;
  font-weight: 500;
}
.question-header p {
  font-size: 10px;
  color: var(--muted);
  margin-top: 3px;
}
.question-stage {
  display: grid;
  place-items: center;
  background: var(--page-bg);
  border-radius: 10px;
  min-height: 150px;
  padding: 15px;
}
.review-image {
  width: 100%;
  height: 250px;
}
.answer-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  margin: 18px 0;
}
.answer-grid > div {
  padding: 15px 20px;
  background: var(--page-bg);
  border-radius: 8px;
}
.answer-grid span {
  display: block;
  font-size: 11px;
  color: var(--muted);
}
.answer-grid strong {
  font-size: 21px;
  font-weight: 500;
  display: block;
  margin-top: 7px;
}
.review-choice {
  display: flex;
  justify-content: center;
  margin: 18px 0;
}
.question-pagination {
  justify-content: center;
  overflow: auto;
}
@media (max-width: 500px) {
  .review-metrics {
    grid-template-columns: repeat(2, 1fr);
    gap: 15px;
  }
}
</style>
