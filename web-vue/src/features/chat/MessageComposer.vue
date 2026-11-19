<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  inject,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { chatKey } from "../../composables/useChat";
import { outboxKey } from "./useOutbox";

import type {
  Member,
  Message,
  MessageBody,
  Page,
  Uploaded,
} from "../../api/types";
import BaseDialog from "../../components/BaseDialog.vue";
import CaptureDialog from "./CaptureDialog.vue";
import { usePreferences } from "../../composables/usePreferences";
const EmojiPicker = defineAsyncComponent(() => import("./EmojiPicker.vue"));
const chat = inject(chatKey)!;
const client = chat.client;
const preferences = usePreferences();
const { active, reply, canSend } = chat;
const outbox = inject(outboxKey)!;
const input = useTemplateRef<HTMLTextAreaElement>("input"),
  fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const draft = shallowRef(""),
  emojiOpen = shallowRef(false),
  mentionOpen = shallowRef(false),
  mentionQuery = shallowRef(""),
  mentionRows = shallowRef<Member[]>([]),
  canMentionAll = shallowRef(false);
const prepared = shallowRef<File[]>([]),
  caption = shallowRef(""),
  original = shallowRef(false),
  previewUrls = shallowRef<string[]>([]);
const transfer = shallowRef(""),
  sendingMedia = shallowRef(false);
const chosen = new Map<number, string>();
const captureMode = shallowRef<"camera" | "voice" | "screen" | null>(null);
let all = false,
  mentionEpoch = 0,
  disposed = false,
  controller: AbortController | undefined;
const mentionIndex = shallowRef(0);
const mentionOptions = computed(() => [
  ...(canMentionAll.value ? [null] : []),
  ...mentionRows.value,
]);
watch(chat.mentionRequest, (value) => {
  if (!value || !canSend.value) return;
  const name = Array.from(
    value.name
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 80)
    .join("");
  if (!name) return;
  chosen.set(value.user, name);
  const at = input.value?.selectionStart ?? draft.value.length,
    end = input.value?.selectionEnd ?? at;
  draft.value =
    draft.value.slice(0, at) +
    (at > 0 && !/\s/.test(draft.value[at - 1]!) ? " " : "") +
    "@" +
    name +
    " " +
    draft.value.slice(end);
  saveDraft();
  input.value?.focus();
});
const mentionPage = shallowRef(1),
  mentionMore = shallowRef(false);
const cardOpen = shallowRef(false),
  cardContacts = shallowRef<Member[]>([]);
watch(canSend, (allowed) => {
  if (!allowed) {
    captureMode.value = null;
    mentionOpen.value = false;
    mentionEpoch++;
  }
});
watch(
  [prepared, captureMode, cardOpen, sendingMedia],
  () => {
    chat.interactionBusy.value =
      !!prepared.value.length ||
      !!captureMode.value ||
      cardOpen.value ||
      sendingMedia.value;
  },
  { flush: "sync" },
);
type MediaDraft = {
  file: File;
  kind: string;
  requestId: string;
  uploaded?: Uploaded;
  sent?: Message;
};
let mediaJob:
  | {
      conversation: number;
      token: string;
      body: MessageBody;
      original: boolean;
      items: MediaDraft[];
    }
  | undefined;
type Draft = {
  text: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  mentions: [number, string][];
  all: boolean;
};
let draftConversation = 0,
  restoring = false,
  filePickConversation = 0;
const draftKey = (id: number) => `pulse_vue_draft:${chat.me.value?.id}:${id}`;
function saveDraft() {
  if (!draftConversation || !chat.me.value || restoring) return;
  const value: Draft = {
    text: draft.value,
    start: input.value?.selectionStart || 0,
    end: input.value?.selectionEnd || 0,
    direction: input.value?.selectionDirection || "none",
    mentions: [...chosen],
    all,
  };
  try {
    if (draft.value)
      localStorage.setItem(draftKey(draftConversation), JSON.stringify(value));
    else localStorage.removeItem(draftKey(draftConversation));
  } catch {
    /* An unavailable local store must not stop editing. */
  }
  chat.drafts.value = {
    ...chat.drafts.value,
    [draftConversation]: draft.value,
  };
}
watch(
  () => chat.me.value?.id,
  () => {
    const values: Record<number, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || "",
        prefix = `pulse_vue_draft:${chat.me.value?.id}:`;
      if (!key.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key) || "";
      let text = raw;
      try {
        const value = JSON.parse(raw);
        if (typeof value?.text === "string") text = value.text;
      } catch {}
      values[Number(key.slice(prefix.length))] = text;
    }
    chat.drafts.value = values;
  },
  { immediate: true },
);
watch(
  () => active.value?.id,
  async (id) => {
    saveDraft();
    draftConversation = id || 0;
    restoring = true;
    const raw = id ? localStorage.getItem(draftKey(id)) || "" : "";
    let saved: Draft = {
      text: raw,
      start: raw.length,
      end: raw.length,
      direction: "none",
      mentions: [],
      all: false,
    };
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.text === "string") saved = { ...saved, ...parsed };
    } catch {}
    draft.value = saved.text;
    chosen.clear();
    for (const [user, name] of saved.mentions) chosen.set(user, name);
    all = saved.all;
    restoring = false;
    mentionOpen.value = false;
    mentionEpoch++;
    captureMode.value = null;
    emojiOpen.value = false;
    cardOpen.value = false;
    if (!sendingMedia.value) cleanupFiles();
    await nextTick();
    if (active.value?.id === id)
      input.value?.setSelectionRange(saved.start, saved.end, saved.direction);
  },
  { flush: "sync", immediate: true },
);
watch(draft, saveDraft, { flush: "sync" });
const pending = computed(() =>
  outbox.pending.value.filter(
    (item) => item.payload.conversation_id === active.value?.id,
  ),
);
function payload(text: string): MessageBody {
  const contains = (name: string) =>
    new RegExp(
      "(?:^|\\s)@" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$)",
      "u",
    ).test(text);
  const ids = [...chosen]
    .filter(([, name]) => contains(name))
    .map(([id]) => id);
  return {
    text,
    ...(reply.value ? { reply_to_id: reply.value.id } : {}),
    ...(ids.length ? { mention_user_ids: ids } : {}),
    ...(all &&
    ["owner", "admin"].includes(active.value?.my_role || "") &&
    contains("所有人")
      ? { mention_all: true }
      : {}),
  };
}
async function send() {
  const id = active.value?.id,
    text = draft.value;
  if (!id || !canSend.value || !text.trim()) return;
  try {
    await outbox.send({
      conversation_id: id,
      type: "text",
      body: payload(text),
      request_id: "text-" + crypto.randomUUID(),
    });
    if (active.value?.id === id && draft.value === text) {
      draft.value = "";
      reply.value = null;
      chosen.clear();
      all = false;
    }
    if (active.value?.id === id) chat.sendRevision.value++;
  } catch (cause) {
    chat.error(cause);
  }
}
function keys(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (
    mentionOpen.value &&
    ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
  ) {
    event.preventDefault();
    if (event.key === "Escape") mentionOpen.value = false;
    else if (event.key === "Enter") {
      const row = mentionOptions.value[mentionIndex.value];
      if (row !== undefined) pick(row);
    } else if (mentionOptions.value.length)
      mentionIndex.value =
        (mentionIndex.value +
          (event.key === "ArrowDown" ? 1 : -1) +
          mentionOptions.value.length) %
        mentionOptions.value.length;
    return;
  }
  if (event.key !== "Enter" || event.altKey) return;
  const ctrl = localStorage.getItem("pulse_setting_send_ctrl_enter") === "1";
  if (
    !event.shiftKey &&
    (ctrl ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.metaKey)
  ) {
    event.preventDefault();
    void send();
  }
}
async function mentions(query = "", append = false) {
  if (!append) mentionPage.value = 1;
  if (active.value?.type !== "group" || !canSend.value) return;
  const id = active.value.id,
    mine = ++mentionEpoch;
  mentionOpen.value = true;
  mentionQuery.value = query;
  try {
    const page = await chat.api<
      Page<Member> & {
        can_mention_all: boolean;
        can_search: boolean;
        conversation_id: number;
      }
    >(
      `/conversations/groups/mention-members?conversation_id=${id}&q=${encodeURIComponent(query)}&page=${mentionPage.value}`,
    );
    if (mine === mentionEpoch && active.value?.id === id) {
      if (page.can_search !== true) {
        mentionOpen.value = false;
        return;
      }
      page.items = page.items.filter((row) => row.id !== chat.me.value?.id);
      mentionIndex.value = 0;
      mentionRows.value = append
        ? [...mentionRows.value, ...page.items]
        : page.items;
      mentionMore.value = page.has_more === true;
      canMentionAll.value =
        page.can_mention_all === true &&
        (!query ||
          "所有人".includes(query.toLowerCase()) ||
          "all".includes(query.toLowerCase()));
    }
  } catch (cause) {
    if (mine === mentionEpoch) chat.error(cause);
  }
}
let mentionTimer: ReturnType<typeof setTimeout> | undefined;
function onInput() {
  clearTimeout(mentionTimer);
  const at = input.value?.selectionStart ?? draft.value.length;
  const match = /(?:^|\s)@([^@\s]*)$/.exec(draft.value.slice(0, at));
  if (match && active.value?.type === "group")
    mentionTimer = setTimeout(() => {
      void mentions(match[1]);
    }, 150);
  else {
    mentionOpen.value = false;
    mentionEpoch++;
  }
}
function pick(member: Member | null) {
  if (!canSend.value) return;
  const name = member?.nickname || "所有人";
  const at = input.value?.selectionStart ?? draft.value.length;
  const prefix = draft.value.slice(0, at).replace(/@[^@\s]*$/, "");
  draft.value = prefix + "@" + name + " " + draft.value.slice(at);
  if (member) chosen.set(member.id, name);
  else all = true;
  mentionOpen.value = false;
  saveDraft();
  input.value?.focus();
}
function insertEmoji(text: string) {
  const at = input.value?.selectionStart ?? draft.value.length;
  const end = input.value?.selectionEnd ?? at;
  draft.value = draft.value.slice(0, at) + text + draft.value.slice(end);
  void nextTick(() =>
    input.value?.setSelectionRange(at + text.length, at + text.length),
  );
  input.value?.focus();
}
function selectFiles(files: File[]) {
  if (!active.value || !canSend.value || sendingMedia.value) return;
  if (files.length > 10) {
    chat.error(Error("每次最多发送 10 个附件"));
    return;
  }
  cleanupFiles();
  prepared.value = files;
  previewUrls.value = files.map((file) =>
    file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
  );
  caption.value = "";
}
function cleanupFiles() {
  previewUrls.value.forEach((url) => url && URL.revokeObjectURL(url));
  previewUrls.value = [];
  prepared.value = [];
  mediaJob = undefined;
}
async function upload() {
  if (sendingMedia.value || !prepared.value.length) return;
  if (!mediaJob) {
    if (!active.value || !canSend.value) return;
    mediaJob = {
      conversation: active.value.id,
      token: client.token,
      body: payload(caption.value),
      original: original.value,
      items: prepared.value.map((file) => ({
        file,
        kind: file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
            ? "video"
            : file.type.startsWith("audio/")
              ? "voice"
              : "file",
        requestId: "media-" + crypto.randomUUID(),
      })),
    };
  }
  const job = mediaJob,
    id = job.conversation;
  sendingMedia.value = true;
  controller = new AbortController();
  try {
    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i]!;
      if (item.sent) continue;
      controller.signal.throwIfAborted();
      if (job.token !== client.token || disposed) return;
      transfer.value = `正在发送 ${i + 1}/${job.items.length}`;
      if (!item.uploaded)
        item.uploaded = await client.uploadMedia(item.kind, item.file, {
          original: job.original,
          signal: controller.signal,
          onProgress: (value) => {
            if (!disposed)
              transfer.value = `${i + 1}/${job.items.length} · ${value.stage === "hash" ? "校验附件" : value.stage === "processing" ? "服务器处理" : "上传中"}`;
          },
        });
      if (job.token !== client.token || disposed) return;
      const media = item.uploaded;
      item.sent = await chat.api<Message>("/messages", {
        method: "POST",
        body: {
          conversation_id: id,
          type: item.kind,
          body: {
            url: media.url,
            name: item.file.name,
            mime: media.mime,
            size: media.size,
            width: media.width,
            height: media.height,
            original: job.original,
            ...(i === 0 ? job.body : {}),
          },
          request_id: item.requestId,
        },
        signal: controller.signal,
      });
      if (active.value?.id === id) {
        chat.mergeMessages([item.sent]);
        chat.sendRevision.value++;
      }
      void chat.summary([id]);
    }
    cleanupFiles();
    if (active.value?.id === id) reply.value = null;
  } catch (cause) {
    if (!disposed) chat.error(cause);
  } finally {
    if (!disposed) {
      sendingMedia.value = false;
      transfer.value = mediaJob
        ? "未完成的附件可重试，已发送的附件不会再次发送"
        : "";
    }
  }
}
async function card(user?: number) {
  if (user === undefined) {
    try {
      const rows: Member[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await chat.api<Page<Member>>(
          "/contacts?size=100&page=" + page,
        );
        rows.push(...result.items);
        if (
          result.items.length < 100 ||
          (result.total != null && rows.length >= result.total)
        )
          break;
      }
      cardContacts.value = rows;
      cardOpen.value = true;
    } catch (cause) {
      chat.error(cause);
    }
    return;
  }
  const id = active.value?.id;
  if (!user || !id) return;
  try {
    const sent = await chat.post<Message>("/messages", {
      conversation_id: id,
      type: "contact_card",
      body: { user_id: Number(user) },
      request_id: "card-" + crypto.randomUUID(),
    });
    chat.mergeMessages([sent]);
    chat.sendRevision.value++;
    cardOpen.value = false;
  } catch (cause) {
    chat.error(cause);
  }
}
async function shake() {
  if (!active.value || !canSend.value) return;
  try {
    const sent = await chat.post<Message>("/messages", {
      conversation_id: active.value.id,
      type: "shake",
      body: {},
      request_id: "shake-" + crypto.randomUUID(),
    });
    chat.mergeMessages([sent]);
  } catch (cause) {
    chat.error(cause);
  }
}
function paste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) {
    event.preventDefault();
    selectFiles(files);
  }
}
onScopeDispose(() => {
  saveDraft();
  clearTimeout(mentionTimer);
  chat.interactionBusy.value = false;
  disposed = true;
  mentionEpoch++;
  controller?.abort();
  cleanupFiles();
});
defineExpose({ selectFiles });
</script>
<template>
  <div class="vue-outbox" v-if="pending.length">
    <div v-for="item in pending" :key="item.id">
      <span
        >{{ item.payload.body.text }} ·
        {{ item.status === "failed" ? item.error : "发送中…" }}</span
      ><button @click="outbox.retry(item.id)">重试</button
      ><button @click="outbox.discard(item.id)">取消</button>
    </div>
  </div>
  <form
    id="composer"
    class="vue-composer"
    @submit.prevent="send"
    @paste="paste"
  >
    <div v-if="reply" class="vue-reply">
      回复 {{ reply.sender_name }}：{{ reply.body.text || "附件"
      }}<button type="button" @click="reply = null">取消回复</button>
    </div>
    <div class="vue-composer-tools">
      <button
        type="button"
        :disabled="!canSend"
        @click="
          filePickConversation = active?.id || 0;
          fileInput?.click();
        "
      >
        图片 / 附件</button
      ><input
        ref="fileInput"
        type="file"
        hidden
        multiple
        @change="
          if (!filePickConversation || active?.id === filePickConversation)
            selectFiles([...(($event.target as HTMLInputElement).files || [])]);
          ($event.target as HTMLInputElement).value = '';
        "
      /><button
        type="button"
        :disabled="!canSend"
        @click="emojiOpen = !emojiOpen"
      >
        表情</button
      ><button
        v-if="active?.type === 'group'"
        type="button"
        :disabled="!canSend"
        @click="mentions()"
      >
        @</button
      ><button type="button" :disabled="!canSend" @click="card()">名片</button
      ><button type="button" :disabled="!canSend" @click="shake">
        窗口抖动
      </button>
      <button
        type="button"
        :disabled="!canSend"
        @click="captureMode = 'screen'"
      >
        截图</button
      ><button
        type="button"
        :disabled="!canSend"
        @click="captureMode = 'camera'"
      >
        拍照</button
      ><button
        type="button"
        :disabled="!canSend"
        @click="captureMode = 'voice'"
      >
        录音
      </button>
    </div>
    <EmojiPicker
      v-if="emojiOpen"
      @pick="insertEmoji"
      @close="emojiOpen = false"
    />
    <div
      v-if="mentionOpen"
      class="vue-mention-picker"
      role="listbox"
      aria-label="艾特群成员"
    >
      <input
        @keydown.enter.prevent="mentions(mentionQuery)"
        v-model="mentionQuery"
        aria-label="搜索群成员"
        placeholder="搜索昵称或用户名"
        @input="mentions(mentionQuery)"
      /><button v-if="canMentionAll" type="button" @click="pick(null)">
        所有人</button
      ><button
        v-for="member in mentionRows"
        :key="member.id"
        type="button"
        @click="pick(member)"
      >
        {{ member.nickname }}</button
      ><button
        v-if="mentionMore"
        type="button"
        @click="
          mentionPage++;
          mentions(mentionQuery, true);
        "
      >
        加载更多成员</button
      ><button type="button" @click="mentionOpen = false">关闭</button>
    </div>
    <textarea
      ref="input"
      id="message-input"
      :spellcheck="preferences.setting('spellcheck')"
      v-model="draft"
      aria-label="输入消息"
      placeholder="输入消息"
      :disabled="!canSend"
      rows="3"
      maxlength="5000"
      @keydown="keys"
      @select="saveDraft"
      @click="saveDraft"
      @keyup="saveDraft"
      @blur="saveDraft"
      @input="onInput"
    ></textarea>
    <div class="vue-composer-submit">
      <small v-if="!canSend">{{
        active?.send_disabled_reason === "member_muted"
          ? "你已被禁言"
          : active?.send_disabled_reason === "group_muted"
            ? "群组已开启全体禁言"
            : "请先选择有发言权限的会话"
      }}</small><button class="primary" :disabled="!canSend || !draft.trim()">
        发送
      </button>
    </div>
  </form>
  <BaseDialog
    v-if="prepared.length"
    :title="
      mediaJob && active?.id !== mediaJob.conversation
        ? '发送附件 · 原会话'
        : '发送附件'
    "
    @close="!sendingMedia && cleanupFiles()"
    ><div class="vue-media-previews">
      <figure v-for="(file, index) in prepared" :key="index">
        <img
          v-if="previewUrls[index]"
          :src="previewUrls[index]"
          alt="待发送图片"
        />
        <figcaption>{{ file.name }}</figcaption>
      </figure>
    </div>
    <label
      >添加说明<textarea
        v-model="caption"
        :disabled="sendingMedia || !!mediaJob"
        maxlength="1000"
      ></textarea></label
    ><label
      ><input
        v-model="original"
        type="checkbox"
        :disabled="sendingMedia || !!mediaJob"
      />发送原图</label
    >
    <p role="status">{{ transfer }}</p>
    <template #footer>
      <button v-if="sendingMedia" @click="controller?.abort()">
        停止后续发送</button
      ><button class="primary" :disabled="sendingMedia" @click="upload">
        发送
      </button>
    </template></BaseDialog
  >
  <BaseDialog v-if="cardOpen" title="选择联系人名片" @close="cardOpen = false"
    ><button
      v-for="contact in cardContacts"
      :key="contact.id"
      @click="card(contact.id)"
    >
      {{ contact.remark || contact.nickname }}
    </button>
    <p v-if="!cardContacts.length">暂无联系人</p></BaseDialog
  >
  <CaptureDialog
    v-if="captureMode"
    :mode="captureMode"
    @close="captureMode = null"
    @file="selectFiles([$event])"
  />
</template>
