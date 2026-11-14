<script setup lang="ts">
import CrudPage from "../components/CrudPage.vue";
import type { CrudDefinition } from "../components/CrudPage.vue";
import { options, tagStatus, labelStatus } from "../domain/catalog";
const definition: CrudDefinition = {
  key: "routes",
  title: "线路管理",
  endpoint: "/admin/client-routes",
  deleteEndpoint: "/admin/client-routes/delete",
  defaults: {
    name: "",
    url: "",
    ws_url: "",
    media_url: "",
    sort: 0,
    status: "enabled",
  },
  filters: [
    { key: "name", label: "线路名称" },
    {
      key: "status",
      label: "状态",
      type: "select",
      options: options({ enabled: "启用", disabled: "停用" }),
    },
  ],
  fields: [
    {
      key: "name",
      label: "线路名称",
      required: true,
      maxLength: 64,
      wide: true,
    },
    {
      key: "url",
      label: "API 地址",
      required: true,
      maxLength: 2048,
      wide: true,
      help: "使用 HTTPS，保留客户端要求的 /api/v2 路径。",
    },
    {
      key: "ws_url",
      label: "WebSocket 地址",
      maxLength: 2048,
      wide: true,
      help: "使用 WSS，例如 wss://api.example.com/api/v2/realtime。",
    },
    { key: "media_url", label: "媒体地址", maxLength: 2048, wide: true },
    { key: "sort", label: "排序", type: "number", min: 0, max: 100000 },
    {
      key: "status",
      label: "状态",
      type: "select",
      options: options({ enabled: "启用", disabled: "停用" }),
    },
  ],
  columns: [
    { key: "name", label: "线路名称", minWidth: 170 },
    { key: "url", label: "API / WebSocket / 媒体地址", minWidth: 400 },
    { key: "sort", label: "排序", width: 90 },
    {
      key: "status",
      label: "状态",
      width: 100,
      format: (r) => labelStatus(r.status),
      tag: (r) => tagStatus(r.status),
    },
    { key: "updated_at", label: "更新时间", minWidth: 175 },
  ],
  validate(row) {
    for (const key of ["url", "ws_url", "media_url"])
      if (row[key]) {
        let parsed: URL;
        try {
          parsed = new URL(row[key]);
        } catch {
          throw new Error("请填写有效的线路地址");
        }
        if (
          parsed.username ||
          parsed.password ||
          !(key === "ws_url" ? ["wss:"] : ["https:"]).includes(parsed.protocol)
        )
          throw new Error("正式线路必须使用无嵌入凭据的 HTTPS / WSS 地址");
      }
  },
};
</script>
<template>
  <CrudPage :definition="definition"
    ><template #url="{ row }"
      ><span>{{ row.url }}</span>
      <p class="text-xs muted">{{ row.ws_url || "自动生成实时地址" }}</p>
      <p class="text-xs muted">
        {{ row.media_url || "使用 API 地址读取媒体" }}
      </p>
      <p v-if="row.valid_for_failover === false" class="text-xs text-red-500">
        线路需要修正为有效的 HTTPS 地址
      </p></template
    ></CrudPage
  >
</template>
