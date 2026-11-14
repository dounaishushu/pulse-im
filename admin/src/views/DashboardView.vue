<script setup lang="ts">
import { shallowRef, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { get, post, query } from "../api/client";
import { useAction } from "../composables/useAction";
import { usePageData } from "../composables/usePageData";
import { can, useSession } from "../stores/session";
import { formatTime } from "../domain/catalog";
import type { RecordData, TableColumn } from "../domain/types";
import PageHeader from "../components/PageHeader.vue";
import ArtIcon from "../components/ArtIcon.vue";
import ArtStatsCard from "../components/ArtStatsCard.vue";
import ArtTable from "../components/ArtTable.vue";
import TablePagination from "../components/TablePagination.vue";
import RegistrationMap from "../features/dashboard/RegistrationMap.vue";
const router = useRouter(),
  session = useSession(),
  action = useAction();
const stats = shallowRef<RecordData>({ users: {} }),
  health = shallowRef<RecordData>({}),
  regions = shallowRef<RecordData>({ provinces: [] });
const loading = shallowRef(true),
  error = shallowRef(""),
  regionError = shallowRef(""),
  healthError = shallowRef("");
const offsite = usePageData("/admin/stats/offsite-logins", 30);
const controller = new AbortController();
const offsiteColumns: TableColumn[] = [
  { key: "account", label: "用户", minWidth: 190 },
  { key: "register_location", label: "注册归属地", minWidth: 180 },
  { key: "login_location", label: "登录归属地", minWidth: 180 },
  {
    key: "login_at",
    label: "最近成功登录",
    minWidth: 170,
    format: (r) => formatTime(r.login_at),
  },
];
async function load() {
  loading.value = true;
  error.value = "";
  const results = await Promise.allSettled([
    get("/admin/stats", controller.signal),
    get("/health", controller.signal),
    get("/admin/stats/regions", controller.signal),
  ]);
  if (controller.signal.aborted) return;
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (i === 0) stats.value = result.value;
      else if (i === 1) health.value = result.value;
      else regions.value = result.value;
    } else if (result.reason.name !== "AbortError") {
      if (i === 0) error.value = result.reason.message;
      else if (i === 1) healthError.value = result.reason.message;
      else regionError.value = result.reason.message;
    }
  });
  loading.value = false;
}
async function resolveRegions() {
  await action.run(async () => {
    regions.value = await post(
      "/admin/stats/regions/resolve",
      {},
      controller.signal,
    );
    regionError.value = "";
  });
}
async function resolveOffsite() {
  await action.run(async () => {
    const result = await post(
      query("/admin/stats/offsite-logins/resolve", {
        page: offsite.page.value,
        size: offsite.pageSize.value,
      }),
      {},
      controller.signal,
    );
    offsite.data.value = result as any;
  });
}
const shortcuts = [
  { key: "users", title: "用户管理", icon: "User" },
  {
    key: "task-records",
    title: "作业批改",
    icon: "EditPen",
  },
  {
    key: "groups",
    title: "群组管理",
    icon: "ChatLineSquare",
  },
];
onMounted(() => {
  void load();
  void offsite.load();
});
onBeforeUnmount(() => controller.abort());
</script>
<template>
  <PageHeader title="运营总览"
    ><span class="dashboard-date"
      ><ArtIcon name="Calendar" :size="15" />{{
        new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "long",
          day: "numeric",
        }).format(new Date())
      }}</span
    ><el-button :loading="loading" @click="load"
      >刷新数据</el-button
    ></PageHeader
  >
  <el-alert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="mb-6"
    show-icon
  />
  <div v-loading="loading" class="dashboard-metrics">
    <ArtStatsCard
      title="注册用户"
      :count="stats.users.total"
      :description="`${stats.users.online || 0} 人近期活跃`"
      icon="User"
    /><ArtStatsCard
      title="会话总数"
      :count="stats.conversations"
      :description="`${stats.today_logins || 0} 次今日成功登录`"
      icon="ChatLineSquare"
      color="green"
    /><ArtStatsCard
      title="今日消息"
      :count="stats.today_messages"
      icon="ChatDotRound"
      color="purple"
    /><ArtStatsCard
      title="冻结账号"
      :count="stats.users.frozen"
      icon="Lock"
      color="orange"
    />
  </div>
  <div class="dashboard-middle">
    <section class="art-card section-card region-card">
      <div class="section-heading">
        <div>
          <h2>注册用户分布</h2>
        </div>
        <el-tag type="primary" round
          >{{ regions.identified || 0 }} 人已识别</el-tag
        >
      </div>
      <el-alert
        v-if="regionError"
        :title="regionError"
        type="error"
        :closable="false"
      /><RegistrationMap :provinces="regions.provinces" />
      <div class="region-stats">
        <span
          >国内 <b>{{ regions.domestic || 0 }}</b></span
        ><span
          >海外 <b>{{ regions.overseas || 0 }}</b></span
        ><span
          >未识别 <b>{{ regions.unknown || 0 }}</b></span
        ><el-button
          v-if="
            regions.pending_ip_count &&
            regions.lookup_available &&
            session.isSuper.value
          "
          link
          type="primary"
          :loading="action.busy.value"
          @click="resolveRegions"
          >补全 {{ regions.pending_ip_count }} 个 IP</el-button
        >
      </div>
      <p v-if="regions.lookup_available === false" class="field-help">
        IP 归属地服务未配置
      </p>
    </section>
    <section class="art-card section-card service-card">
      <div class="section-heading">
        <div>
          <h2>服务状态</h2>
        </div>
        <span class="status-dot" />
      </div>
      <el-alert
        v-if="healthError"
        :title="healthError"
        type="error"
        :closable="false"
      />
      <div
        v-for="component in [
          { key: 'database', name: 'PostgreSQL', icon: 'Coin' },
          { key: 'realtime', name: 'Redis 与实时服务', icon: 'Connection' },
          { key: 'websocket', name: 'WebSocket', icon: 'Link' },
          { key: 'dispatch', name: '分发调度', icon: 'Promotion' },
          { key: 'push', name: '移动推送', icon: 'Bell' },
        ]"
        :key="component.key"
        class="service-row"
      >
        <span class="service-row-icon"
          ><ArtIcon :name="component.icon" :size="18"
        /></span>
        <div>
          <strong>{{ component.name }}</strong><small
            v-if="component.key !== 'realtime'"
            >{{
              component.key === "database"
                ? health.database?.latency_ms !== undefined
                  ? `${health.database.latency_ms} ms`
                  : "等待检查"
                : component.key === "websocket"
                  ? `${health.websocket?.connections ?? "—"} 条连接`
                  : component.key === "push"
                    ? `${health.push?.pending_jobs ?? "—"} 个待推送任务`
                    : component.key === "dispatch"
                      ? `${health.dispatch?.pending ?? "—"} 个待发送任务`
                      : ""
            }}</small
          >
        </div>
        <el-tag
          :type="
            health[component.key]?.status === 'up'
              ? 'success'
              : health[component.key]?.status === 'unconfigured'
                ? 'info'
                : 'warning'
          "
          size="small"
          round
          >{{
            health[component.key]?.status === "up"
              ? "运行正常"
              : health[component.key]?.status === "unconfigured"
                ? "未配置"
                : health[component.key]?.status === "down"
                  ? "异常"
                  : "待确认"
          }}</el-tag
        >
      </div>
      <p class="service-foot">
        <ArtIcon name="Clock" :size="12" />{{
          stats.generated_at
            ? `更新于 ${formatTime(stats.generated_at)}`
            : "尚未取得数据"
        }}
      </p>
    </section>
  </div>
  <section class="art-card section-card">
    <div class="section-heading">
      <div>
        <h2>异地登录核查</h2>
      </div>
      <div>
        <el-button
          v-if="
            offsite.data.value.pending_ip_count &&
            offsite.data.value.lookup_available &&
            session.isSuper.value
          "
          text
          type="primary"
          :loading="action.busy.value"
          @click="resolveOffsite"
          >补全地区</el-button
        ><el-button
          text
          circle
          aria-label="刷新异地登录"
          @click="offsite.load()"
          ><ArtIcon name="Refresh" :size="17"
        /></el-button>
      </div>
    </div>
    <ArtTable
      v-if="
        offsite.data.value.items.length ||
        offsite.loading.value ||
        offsite.error.value
      "
      :rows="offsite.data.value.items"
      :columns="offsiteColumns"
      :loading="offsite.loading.value"
      :error="offsite.error.value"
      @retry="offsite.load()"
      ><template #account="{ row }"
        ><div class="person-cell">
          <el-avatar :size="32" :src="row.avatar_url">{{
            (row.nickname || row.account || "用").slice(0, 1)
          }}</el-avatar>
          <div>
            <strong>{{ row.nickname || row.account }}</strong><small>{{
              row.account
            }}</small>
          </div>
        </div></template
      ><template #register_location="{ row }"
        >{{ row.register_location }}
        <p class="text-xs muted">{{ row.register_ip }}</p></template
      ><template #login_location="{ row }"
        >{{ row.login_location }}
        <p class="text-xs muted">{{ row.login_ip }}</p></template
      ></ArtTable
    >
    <div v-else class="offsite-empty" role="status">
      <ArtIcon name="CircleCheck" :size="24" />
      <div>
        <strong>暂无已确认的异地登录用户</strong>
      </div>
    </div>
    <TablePagination
      v-if="offsite.data.value.items.length"
      :total="offsite.data.value.total"
      :page="offsite.page.value"
      :size="offsite.pageSize.value"
      :loading="offsite.loading.value"
      @change="
        (p, s) => {
          offsite.page.value = p;
          offsite.pageSize.value = s;
          offsite.load();
        }
      "
    />
    <p v-if="offsite.data.value.unknown_users" class="field-help">
      还有 {{ offsite.data.value.unknown_users }} 人的地区待识别，{{
        offsite.data.value.no_login_users || 0
      }}
      人暂无成功登录记录。
    </p>
  </section>
  <section class="dashboard-shortcuts">
    <template v-for="item in shortcuts" :key="item.key"
      ><button
        v-if="can(item.key)"
        class="art-card shortcut-card"
        @click="router.push({ name: item.key })"
      >
        <span class="shortcut-icon"
          ><ArtIcon :name="item.icon" :size="22"
        /></span>
        <div>
          <strong>{{ item.title }}</strong>
        </div>
        <ArtIcon name="Right" :size="18" /></button
    ></template>
  </section>
</template>
<style scoped>
.dashboard-date {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
  margin-right: 5px;
}
.dashboard-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 18px;
}
.dashboard-middle {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
  gap: 18px;
}
.region-stats {
  display: flex;
  align-items: center;
  gap: 18px;
  font-size: 11px;
  color: var(--muted);
  border-top: 1px solid var(--hairline);
  padding-top: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.region-stats b {
  color: var(--ink);
  font-weight: 500;
  margin-left: 6px;
}
.service-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--hairline);
}
.service-row > div {
  flex: 1;
  min-width: 0;
}
.service-row strong {
  display: block;
  font-weight: 500;
  font-size: 12px;
}
.service-row small {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-top: 4px;
}
.service-row-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--page-bg);
  color: var(--muted);
}
.service-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 10px;
  margin-top: 14px;
}
.dashboard-shortcuts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 12px;
}
.shortcut-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  text-align: left;
  border: 0;
  color: var(--ink);
}
.shortcut-icon {
  display: grid;
  place-items: center;
  width: 43px;
  height: 43px;
  border-radius: 11px;
  background: var(--el-color-primary-light-9);
  color: var(--main-color);
}
.shortcut-card > div {
  flex: 1;
}
.shortcut-card strong {
  font-size: 13px;
  font-weight: 500;
}
.shortcut-card > .el-icon {
  color: var(--muted);
}
.offsite-empty {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  background: var(--page-bg);
  border-radius: 8px;
}
.offsite-empty > .el-icon {
  color: var(--el-color-success);
  flex-shrink: 0;
}
.offsite-empty strong {
  font-size: 13px;
  font-weight: 500;
}
@container (max-width: 760px) {
  .dashboard-middle {
    grid-template-columns: 1fr;
  }
  .dashboard-metrics {
    gap: 14px;
  }
}
@media (max-width: 700px) {
  .dashboard-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .dashboard-shortcuts {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .dashboard-date {
    display: none;
  }
}
</style>
