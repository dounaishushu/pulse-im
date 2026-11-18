<script setup lang="ts">
import { computed, shallowRef } from "vue";
import groups from "virtual:pulse-emoji-data";
const emit = defineEmits<{ pick: [emoji: string]; close: [] }>();
const category = shallowRef(0),
  query = shallowRef("");
const panel = shallowRef("emoji");
const loaded = shallowRef<Record<string, boolean>>({}),
  failed = shallowRef<Record<string, boolean>>({});
const aliases: Record<string, string> = {
  "😀": "开心",
  "😃": "开心",
  "😄": "开心",
  "😁": "开心",
  "🥰": "喜欢",
  "😍": "喜欢 爱",
  "👍": "赞 同意",
  "👎": "踩 不同意",
  "🙏": "谢谢 祈祷",
  "👏": "鼓掌",
  "❤️": "爱心 喜欢",
  "🎁": "礼物",
  "🔥": "火 热门",
  "😢": "难过",
};
const asset = (value: string) =>
  "./emoji/" +
  [...value].map((char) => char.codePointAt(0)!.toString(16)).join("_") +
  ".svg";
const defaultRecent = [
  ["😂", "笑哭"],
  ["😘", "亲亲"],
  ["❤️", "爱心"],
  ["😍", "喜欢"],
  ["😊", "开心"],
  ["😁", "微笑"],
  ["👍", "赞"],
  ["😅", "汗"],
  ["😌", "安心"],
  ["😃", "高兴"],
  ["😭", "大哭"],
  ["💋", "亲吻"],
  ["😏", "得意"],
  ["😮", "惊讶"],
  ["😛", "调皮"],
  ["🙈", "害羞"],
  ["😉", "眨眼"],
  ["😃", "高兴"],
  ["😢", "难过"],
  ["😆", "大笑"],
  ["😱", "害怕"],
  ["😡", "生气"],
  ["😉", "眨眼"],
  ["😞", "失望"],
  ["😅", "汗"],
  ["😐", "平静"],
  ["🙊", "不说"],
  ["😌", "安心"],
  ["😀", "开心"],
  ["😛", "调皮"],
  ["😆", "大笑"],
  ["👌", "好的"],
  ["😐", "平静"],
  ["😕", "困惑"],
];
let saved: [string, string][] = [];
try {
  const parsed = JSON.parse(
    localStorage.getItem("pulse_recent_emojis") || "[]",
  );
  if (Array.isArray(parsed))
    saved = parsed
      .filter(
        (row): row is [string, string] =>
          Array.isArray(row) &&
          row.length === 2 &&
          typeof row[0] === "string" &&
          typeof row[1] === "string",
      )
      .slice(0, 36);
} catch {}
const recent = shallowRef(
  saved.length ? saved : (defaultRecent as [string, string][]),
);
const categories = computed(() => [
  { name: "最近使用", items: recent.value },
  ...groups,
]);
const rows = computed(() =>
  query.value
    ? groups
        .flatMap((group) => group.items)
        .filter(([emoji, name]) =>
          (emoji + name + (aliases[emoji] || "")).includes(query.value),
        )
        .slice(0, 200)
    : categories.value[category.value]?.items || [],
);
function pick(emoji: string) {
  recent.value = [
    [emoji, "最近使用"] as [string, string],
    ...recent.value.filter(([value]) => value !== emoji),
  ].slice(0, 36);
  localStorage.setItem("pulse_recent_emojis", JSON.stringify(recent.value));
  emit("pick", emoji);
}
</script>
<template>
  <section class="vue-emoji-picker" role="dialog" aria-label="表情">
    <nav aria-label="表情类型">
      <button
        v-for="kind in ['emoji', 'sticker', 'gif']"
        :key="kind"
        type="button"
        :aria-pressed="panel === kind"
        @click="panel = kind"
      >
        {{
          kind === "emoji"
            ? "EMOJI"
            : kind === "sticker"
              ? "贴纸"
              : "GIF 动态图"
        }}
      </button>
    </nav>
    <p v-if="panel !== 'emoji'">
      {{ panel === "sticker" ? "暂无贴纸" : "暂无 GIF 动态图" }}
    </p>
    <div v-show="panel === 'emoji'">
      <input v-model="query" placeholder="搜索表情" aria-label="搜索表情" />
      <nav>
        <button
          v-for="(group, index) in categories"
          :key="group.name"
          type="button"
          @click="
            category = index;
            query = '';
          "
        >
          {{ group.name }}
        </button>
      </nav>
      <div>
        <button
          v-for="([emoji, label], index) in rows"
          :key="emoji + index"
          type="button"
          :title="label"
          :aria-label="emoji"
          @click="pick(emoji)"
        >
          <img
            v-if="!failed[emoji]"
            :src="asset(emoji)"
            width="26"
            height="26"
            alt=""
            loading="lazy"
            :style="{ visibility: loaded[emoji] ? 'visible' : 'hidden' }"
            @load="loaded = { ...loaded, [emoji]: true }"
            @error="failed = { ...failed, [emoji]: true }"
          /><span v-if="!loaded[emoji] || failed[emoji]">{{ emoji }}</span>
        </button>
      </div>
    </div>
    <button type="button" @click="emit('close')">关闭</button>
  </section>
</template>
