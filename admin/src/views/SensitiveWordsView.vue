<script setup lang="ts">
import CrudPage from "../components/CrudPage.vue";
import type { CrudDefinition } from "../components/CrudPage.vue";
const definition: CrudDefinition = {
  key: "sensitive-words",
  title: "敏感词管理",
  endpoint: "/admin/sensitive-words",
  deleteEndpoint: "/admin/sensitive-words/batch-delete",
  defaults: { word: "", replacement: "*" },
  filters: [{ key: "q", label: "匹配文字" }],
  fields: [
    {
      key: "word",
      label: "匹配文字",
      required: true,
      maxLength: 128,
      wide: true,
    },
    {
      key: "replacement",
      label: "替换文字",
      maxLength: 128,
      help: "留空表示删除匹配文字。",
      wide: true,
    },
  ],
  columns: [
    { key: "word", label: "匹配文字", minWidth: 220 },
    {
      key: "replacement",
      label: "替换文字",
      minWidth: 220,
      format: (r) => (r.replacement === "" ? "删除匹配文字" : r.replacement),
    },
    { key: "created_at", label: "创建时间", minWidth: 180 },
    { key: "updated_at", label: "更新时间", minWidth: 180 },
  ],
};
</script>
<template><CrudPage :definition="definition" /></template>
