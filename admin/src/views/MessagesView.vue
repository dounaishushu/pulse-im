<script setup lang="ts">
import { computed, reactive, shallowRef, onMounted } from "vue";
import { useRoute } from "vue-router";
import { post } from "../api/client";
import { can } from "../stores/session";
import { usePageData } from "../composables/usePageData";
import { useAction, confirmAction } from "../composables/useAction";
import { formatTime, options } from "../domain/catalog";
import type { TableColumn, RecordData } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtTable from "../components/ArtTable.vue";
import TablePagination from "../components/TablePagination.vue";
import MessageContent from "../features/messages/MessageContent.vue";
const route = useRoute(),
  pageKey = computed(() => String(route.name));
const { data, loading, error, page, pageSize, load } = usePageData(
  "/admin/messages",
  30,
);
const filters = reactive({
    sender: "",
    receiver: "",
    conversation_type: "",
    type: "",
    q: "",
  }),
  action = useAction(),
  detail = shallowRef<RecordData | null>(null);
const kinds: Record<string, string> = {
  text: "文字",
  image: "图片",
  video: "视频",
  voice: "语音",
  file: "文件",
  contact_card: "名片",
  shake: "抖动",
  system: "系统",
};
const conversations: Record<string, string> = {
  direct: "个人",
  group: "群聊",
  channel: "频道",
  customer_service: "客服",
};
const columns: TableColumn[] = [
  { key: "id", label: "编号", width: 80 },
  { key: "conversation", label: "会话", minWidth: 165 },
  { key: "sender", label: "发送者", minWidth: 165 },
  { key: "receiver", label: "接收者", minWidth: 165 },
  {
    key: "type",
    label: "类型",
    width: 90,
    format: (r) => kinds[r.type] || r.type,
  },
  { key: "body", label: "消息内容", minWidth: 250 },
  {
    key: "created_at",
    label: "发送时间",
    minWidth: 175,
    format: (r) => formatTime(r.created_at),
  },
  {
    key: "status",
    label: "状态",
    width: 100,
    format: (r) => (r.recalled_at ? "已撤回" : "已发送"),
    tag: (r) => (r.recalled_at ? "danger" : "success"),
  },
];
function reload(reset = false) {
  return load(filters, reset);
}
function reset() {
  Object.assign(filters, {
    sender: "",
    receiver: "",
    conversation_type: "",
    type: "",
    q: "",
  });
  return reload(true);
}
async function recall(row: RecordData) {
  if (
    !can(pageKey.value, true) ||
    !(await confirmAction(`确认撤回消息 #${row.id}？`))
  )
    return;
  await action.run(async () => {
    await post("/admin/messages/recall", {
      message_id: row.id,
      request_id: crypto.randomUUID(),
    });
    detail.value = null;
    await reload();
  }, "消息已撤回");
}
onMounted(() => reload());
</script>
<template>
  <PageHeader :title="pageKey === 'moderation' ? '内容审核' : '消息与会话'" />
  <section class="art-card section-card">
    <form class="filters" @submit.prevent="reload(true)">
      <label
        >发送者<el-input
          v-model="filters.sender"
          placeholder="完整账号 / 用户 ID"
          clearable
          maxlength="128" /></label
      ><label
        >接收者<el-input
          v-model="filters.receiver"
          placeholder="完整账号 / 用户 ID"
          clearable
          maxlength="128" /></label
      ><label
        >会话类型<el-select
          v-model="filters.conversation_type"
          clearable
          placeholder="全部"
          ><el-option
            v-for="item in options(conversations)"
            :key="item.value as string"
            :value="item.value"
            :label="item.label" /></el-select></label
      ><label
        >消息类型<el-select v-model="filters.type" clearable placeholder="全部"
          ><el-option
            v-for="item in options(kinds)"
            :key="item.value as string"
            :value="item.value"
            :label="item.label" /></el-select></label
      ><label
        >消息内容<el-input
          v-model="filters.q"
          placeholder="搜索文字内容"
          clearable
          maxlength="500"
      /></label>
      <div class="filter-actions">
        <el-button type="primary" native-type="submit">查询</el-button
        ><el-button @click="reset">重置</el-button>
      </div>
    </form>
    <p class="soft-note">
      同时填写发送者与接收者时，查询该方向的个人消息。用户清空聊天或删除会话后，后台留存记录仍可在这里检索。
    </p>
    <ArtTable
      :rows="data.items"
      :columns="columns"
      :loading="loading"
      :error="error"
      :action-width="pageKey === 'moderation' ? 170 : 90"
      @retry="reload()"
      ><template #conversation="{ row }"
        ><strong>{{ conversations[row.conversation_type] || "会话" }}</strong>
        <p class="text-xs muted">
          {{ row.conversation_name || "#" + row.conversation_id }}
        </p></template
      ><template #sender="{ row }"
        ><span>{{ row.sender_account || row.sender_nickname || "系统" }}</span>
        <p class="text-xs muted">
          {{ row.sender_public_id || "#" + row.sender_id }}
        </p></template
      ><template #receiver="{ row }"
        ><template v-if="row.conversation_type === 'direct'"
          ><div v-for="recipient in row.recipients" :key="recipient.id">
            {{ recipient.account || recipient.nickname }}
            <p class="text-xs muted">
              {{ recipient.public_id || "#" + recipient.id }}
            </p>
          </div></template
        ><span v-else>{{
          row.conversation_name || "#" + row.conversation_id
        }}</span></template
      ><template #body="{ row }"><MessageContent :message="row" /></template
      ><template #actions="{ row }"
        ><el-button link type="primary" @click="detail = row">查看</el-button
        ><el-button
          v-if="
            pageKey === 'moderation' && can(pageKey, true) && !row.recalled_at
          "
          link
          type="danger"
          :disabled="action.busy.value"
          @click="recall(row)"
          >撤回</el-button
        ></template
      ></ArtTable
    ><TablePagination
      :total="data.total"
      :page="page"
      :size="pageSize"
      :has-more="data.has_more"
      :loading="loading"
      @change="
        (p, s) => {
          page = p;
          pageSize = s;
          reload();
        }
      "
    />
  </section>
  <el-drawer
    :model-value="!!detail"
    title="消息详情"
    size="720px"
    destroy-on-close
    @close="detail = null"
    ><template v-if="detail"
      ><el-descriptions :column="2" border class="mb-6"
        ><el-descriptions-item label="消息编号">{{
          detail.id
        }}</el-descriptions-item
        ><el-descriptions-item label="类型">{{
          kinds[detail.type] || detail.type
        }}</el-descriptions-item
        ><el-descriptions-item label="发送者">{{
          detail.sender_account || detail.sender_nickname || "系统"
        }}</el-descriptions-item
        ><el-descriptions-item label="发送时间">{{
          formatTime(detail.created_at)
        }}</el-descriptions-item
        ><el-descriptions-item label="会话">{{
          detail.conversation_name || "#" + detail.conversation_id
        }}</el-descriptions-item
        ><el-descriptions-item label="状态">{{
          detail.recalled_at ? "已撤回" : "已发送"
        }}</el-descriptions-item></el-descriptions
      ><MessageContent :message="detail" detail /></template
    ><template #footer
      ><el-button @click="detail = null">关闭</el-button
      ><el-button
        v-if="
          detail &&
          pageKey === 'moderation' &&
          can(pageKey, true) &&
          !detail.recalled_at
        "
        type="danger"
        :loading="action.busy.value"
        @click="recall(detail)"
        >撤回消息</el-button
      ></template
    ></el-drawer
  >
</template>
