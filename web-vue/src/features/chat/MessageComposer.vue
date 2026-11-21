<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  inject,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import platform from "virtual:pulse-platform";
import type { ExplorerAttachment, UploadAttachment } from "../../platform/contracts";
import { chatKey } from "../../composables/useChat";
import { outboxKey } from "./useOutbox";
import { useComposerScreenshot } from "./useComposerScreenshot";

import type {
  Member,
  Message,
  MessageBody,
  Page,
  Uploaded,
} from "../../api/types";
import BaseDialog from "../../components/BaseDialog.vue";
import UiIcon from "../../components/UiIcon.vue";
import CaptureDialog from "./CaptureDialog.vue";
import ComposerPermissionNotice from "./ComposerPermissionNotice.vue";
import ComposerSendMenu from "./ComposerSendMenu.vue";
import ComposerEditor, { type ComposerDraftText } from "./ComposerEditor.vue";
import { usePreferences } from "../../composables/usePreferences";
const props = defineProps<{ desktop?: boolean }>();
const EmojiPicker = defineAsyncComponent(() => import("./EmojiPicker.vue"));
const chat = inject(chatKey)!;
const client = chat.client;
const screenshot = useComposerScreenshot(chat, (file) => selectFiles([file]));
function captureScreen() {
  if (screenshot.available) void screenshot.take();
  else captureMode.value = "screen";
}
const preferences = usePreferences();
const modifierSend = computed(() =>
  preferences.setting("send_ctrl_enter", false),
);
function changeSendMode(modifier: boolean) {
  localStorage.setItem("pulse_setting_send_ctrl_enter", modifier ? "1" : "0");
  window.dispatchEvent(new Event("pulse:preferences"));
}
const { active, reply, canSend } = chat;
const sendBlockedReason = computed(() => {
  if (!active.value || canSend.value || chat.loading.value || chat.locked.value)
    return "";
  switch (active.value.send_disabled_reason) {
    case "member_muted":
      return "你已被禁言";
    case "group_muted":
      return "群组已开启全体禁言";
    default:
      return "当前会话没有发言权限";
  }
});
const outbox = inject(outboxKey)!;
const editor = useTemplateRef<InstanceType<typeof ComposerEditor>>("editor");
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const videoInput = useTemplateRef<HTMLInputElement>("videoInput");
function openFilePicker(input: HTMLInputElement | null) {
  filePickConversation = active.value?.id || 0;
  input?.click();
}
function onFilesChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!filePickConversation || active.value?.id === filePickConversation)
    selectFiles(Array.from(input.files || []));
  input.value = "";
}
const editorInitial = shallowRef<ComposerDraftText>({ text: "" });
const inlineFiles = shallowRef<UploadAttachment[]>([]);
// Keep IDs while the editor can undo removal of a card. Release them when
// the draft is reset, sent, or closed.
const explorerIds = new Set<string>();
const explorerToken = client.token;
function releaseExplorerFiles() {
  if (!explorerIds.size) return;
  const ids = [...explorerIds];
  explorerIds.clear();
  const desktop = platform.explorerFiles;
  if (desktop) {
    for (let index = 0; index < ids.length; index += 10) {
      void desktop.discard(explorerToken, ids.slice(index, index + 10)).catch(() => {});
    }
  }
}
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
let mentionTimer: ReturnType<typeof setTimeout> | undefined;
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
  const before = editor.value?.beforeCaret() || "";
  editor.value?.replaceText(
    (before && !/\s$/.test(before) ? " " : "") + `@${name} `,
  );
  saveDraft();
  editor.value?.focus();
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
  [prepared, inlineFiles, captureMode, cardOpen, sendingMedia],
  () => {
    chat.interactionBusy.value =
      !!prepared.value.length ||
      !!inlineFiles.value.length ||
      !!captureMode.value ||
      cardOpen.value ||
      sendingMedia.value;
  },
  { flush: "sync" },
);
type MediaDraft = {
  file: UploadAttachment;
  kind: string;
  requestId: string;
  uploaded?: Uploaded;
  sent?: Message;
};
const mediaJob = shallowRef<{
  conversation: number;
  token: string;
  body: MessageBody;
  original: boolean;
  inline: boolean;
  editorRevision: number;
  items: MediaDraft[];
} | null>(null);
const inlineAttachments = computed(() => inlineFiles.value.length > 0);
const inlineImages = computed(() =>
  inlineFiles.value.some((file) => file.type.startsWith("image/")),
);
const inlineTransfer = computed(
  () => inlineAttachments.value && !!mediaJob.value?.inline,
);
const editorDisabled = computed(() => !canSend.value || inlineTransfer.value);
const modalFiles = computed(
  () => mediaJob.value?.items.map((item) => item.file) ?? prepared.value,
);
const attachmentDialog = computed(
  () => modalFiles.value.length > 0 && !inlineAttachments.value,
);
function submitComposer() {
  if (inlineAttachments.value) void upload(true);
  else void send();
}
function receiveDraft(text: string, files: UploadAttachment[]) {
  draft.value = text;
  if (
    files.length !== inlineFiles.value.length ||
    files.some((file, index) => file !== inlineFiles.value[index])
  )
    inlineFiles.value = files;
}
function matchesSendShortcut(event: KeyboardEvent) {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.key !== "Enter" ||
    event.shiftKey ||
    event.altKey
  )
    return false;
  return modifierSend.value === (event.ctrlKey || event.metaKey);
}
type Draft = ComposerDraftText & {
  mentions: [number, string][];
  all: boolean;
};
let editorRevision = 0;
let draftConversation = 0,
  restoring = false,
  filePickConversation = 0;
const draftKey = (id: number) => `pulse_vue_draft:${chat.me.value?.id}:${id}`;
function saveDraft() {
  if (!draftConversation || !chat.me.value || restoring) return;
  const value: Draft = {
    text: draft.value,
    ...editor.value?.selection(),
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
function restoreDraft(id: number | undefined, keepCurrent = true) {
  if (keepCurrent) saveDraft();
  editorRevision++;
  clearTimeout(mentionTimer);
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
  editorInitial.value = saved;
  draft.value = saved.text;
  inlineFiles.value = [];
  releaseExplorerFiles();
  editor.value?.reset(saved);
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
}
watch(() => active.value?.id, (id) => restoreDraft(id), { flush: "sync", immediate: true });
function restoreImportedDraft(event: Event) {
  const id = active.value?.id;
  if (!id || draft.value || inlineFiles.value.length || mediaJob.value) return;
  if ((event as CustomEvent<Set<number>>).detail?.has(id)) restoreDraft(id, false);
}
window.addEventListener("pulse:drafts-imported", restoreImportedDraft);
onScopeDispose(() => window.removeEventListener("pulse:drafts-imported", restoreImportedDraft));
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
  if (!id || !canSend.value || inlineAttachments.value || !text.trim()) return;
  try {
    await outbox.send({
      conversation_id: id,
      type: "text",
      body: payload(text),
      request_id: "text-" + crypto.randomUUID(),
    });
    if (
      active.value?.id === id &&
      !inlineAttachments.value &&
      draft.value === text
    )
      clearSentDraft();
    if (active.value?.id === id) chat.sendRevision.value++;
  } catch (cause) {
    chat.error(cause);
  }
}
function clearSentDraft() {
  chosen.clear();
  all = false;
  reply.value = null;
  editor.value?.reset({ text: "" });
}
function keys(event: KeyboardEvent) {
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
  if (matchesSendShortcut(event)) {
    event.preventDefault();
    submitComposer();
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
function onInput() {
  clearTimeout(mentionTimer);
  const match = /(?:^|\s)@([^@\s]*)$/.exec(editor.value?.beforeCaret() || "");
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
  if (editorDisabled.value) return;
  const name = member?.nickname || "所有人";
  const before = editor.value?.beforeCaret() || "";
  const query = /(?:^|\s)(@[^@\s]*)$/.exec(before)?.[1] || "";
  if (member) chosen.set(member.id, name);
  else all = true;
  editor.value?.replaceText(
    (!query && before && !/\s$/.test(before) ? " " : "") + `@${name} `,
    query.length,
  );
  mentionOpen.value = false;
  saveDraft();
  editor.value?.focus();
}
function insertEmoji(text: string) {
  editor.value?.replaceText(text);
  editor.value?.focus();
}
function selectFiles(files: File[], position?: number) {
  if (!files.length || !active.value || !canSend.value || mediaJob.value)
    return;
  if (props.desktop || inlineAttachments.value) {
    if (editor.value?.insertFiles(files, position) === false)
      chat.error(Error("每次最多发送 10 个附件"));
    return;
  }
  if (files.length > 10) {
    chat.error(Error("每次最多发送 10 个附件"));
    return;
  }
  cleanupFiles();
  caption.value = "";
  prepared.value = files;
  previewUrls.value = files.map((file) =>
    file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
  );
}
function insertExplorerFiles(files: ExplorerAttachment[]) {
  if (!files.length || !canSend.value || mediaJob.value || prepared.value.length ||
    captureMode.value || cardOpen.value || screenshot.busy.value) return false;
  if (!editor.value?.insertFiles(files)) return false;
  for (const { id } of files) explorerIds.add(id);
  return true;
}
function focusEditor() { editor.value?.focus(); }
function cancelInlineAttachments() {
  if (sendingMedia.value) return;
  if (mediaJob.value) {
    const saved = { text: draft.value, ...editor.value?.selection() };
    cleanupFiles();
    releaseExplorerFiles();
    editor.value?.reset(saved);
  } else editor.value?.removeFiles();
  editor.value?.focus();
}
function cleanupFiles() {
  previewUrls.value.forEach((url) => url && URL.revokeObjectURL(url));
  previewUrls.value = [];
  prepared.value = [];
  mediaJob.value = null;
  transfer.value = "";
}
async function upload(inline = false) {
  if (sendingMedia.value) return;
  let job = mediaJob.value;
  if (!job) {
    const files = inline ? inlineFiles.value : prepared.value;
    if (!files.length || !active.value || !canSend.value) return;
    job = {
      conversation: active.value.id,
      token: client.token,
      body: payload(inline ? draft.value : caption.value),
      original: original.value,
      inline,
      editorRevision,
      items: files.map((file) => ({
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
    mediaJob.value = job;
  }
  const { conversation: id, items, token: owner, original: keepOriginal } = job;
  sendingMedia.value = true;
  const attempt = new AbortController();
  controller = attempt;
  const running = new Map<number, Promise<{ uploaded: Uploaded } | { error: unknown }>>();
  let nextMessage = 0;
  function prepare(index: number) {
    const item = items[index];
    if (!item || item.sent || item.uploaded || running.has(index)) return;
    const result = client.uploadMedia(item.kind, item.file, {
      original: keepOriginal,
      signal: attempt.signal,
      onProgress(value) {
        if (disposed || attempt.signal.aborted || index !== nextMessage) return;
        const stage = value.stage === "hash" ? "校验附件" : value.stage === "processing" ? "服务器处理" : "上传中";
        transfer.value = `${index + 1}/${items.length} · ${stage}`;
      },
    }).then((uploaded) => {
      if (!attempt.signal.aborted) item.uploaded = uploaded;
      return { uploaded };
    }, (error: unknown) => ({ error }));
    running.set(index, result);
  }
  try {
    for (const [i, item] of items.entries()) {
      if (item.sent) continue;
      attempt.signal.throwIfAborted();
      if (owner !== client.token || disposed) return;
      nextMessage = i;
      transfer.value = `正在发送 ${i + 1}/${items.length}`;
      prepare(i);
      // Match the old photo queue's two uploads ahead of the ordered send.
      if (item.kind === "image" && items[i + 1]?.kind === "image") prepare(i + 1);
      let media = item.uploaded;
      if (!media) {
        const result = await running.get(i)!;
        running.delete(i);
        if ("error" in result) throw result.error;
        media = result.uploaded;
      }
      attempt.signal.throwIfAborted();
      if (owner !== client.token || disposed) return;
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
        signal: attempt.signal,
      });
      if (active.value?.id === id) {
        chat.mergeMessages([item.sent]);
        chat.sendRevision.value++;
      }
      void chat.summary([id]);
    }
    cleanupFiles();
    if (active.value?.id === id && editorRevision === job.editorRevision) {
      if (job.inline) {
        releaseExplorerFiles();
        clearSentDraft();
      }
      else reply.value = null;
    }
  } catch (cause) {
    if (!disposed) chat.error(cause);
  } finally {
    attempt.abort();
    if (controller === attempt) controller = undefined;
    if (!disposed) {
      sendingMedia.value = false;
      transfer.value = mediaJob.value
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
const shakeSending = shallowRef(false);
async function shake() {
  const target = active.value;
  if (!chat.me.value?.internal_staff || target?.type !== "direct" || !canSend.value || shakeSending.value) return;
  shakeSending.value = true;
  try {
    const sent = await chat.post<Message>("/messages", {
      conversation_id: target.id,
      type: "shake",
      body: { text: "窗口抖动" },
      request_id: "shake-" + crypto.randomUUID(),
    });
    if (!disposed && active.value?.id === target.id) {
      chat.mergeMessages([sent]);
      chat.sendRevision.value++;
      chat.shakeRevision.value++;
    }
  } catch (cause) {
    if (!disposed && active.value?.id === target.id) chat.error(cause);
  } finally {
    shakeSending.value = false;
  }
}

onScopeDispose(() => {
  saveDraft();
  clearTimeout(mentionTimer);
  chat.interactionBusy.value = false;
  disposed = true;
  mentionEpoch++;
  controller?.abort();
  releaseExplorerFiles();
  cleanupFiles();
});
defineExpose({ selectFiles, insertExplorerFiles, focusEditor });
</script>
<template>
  <div class="vue-outbox" v-if="pending.length">
    <div v-for="item in pending" :key="item.id">
      <span
        >{{ item.payload.body.text }} ·
        {{ item.status === "failed" ? item.error : item.status === "queued" ? "等待发送…" : "发送中…" }}</span
      ><button v-if="item.status === 'failed'" @click="outbox.retry(item.id)">重试</button
      ><button v-if="item.status === 'failed'" @click="outbox.discard(item.id)">移除</button>
    </div>
  </div>
  <form
    id="composer"
    class="vue-composer"
    :class="{ 'composer-desktop': desktop }"
    @submit.prevent="submitComposer"
  >
    <div v-if="reply" class="vue-reply">
      回复 {{ reply.sender_name }}：{{ reply.body.text || "附件"
      }}<button type="button" @click="reply = null">取消回复</button>
    </div>
    <input
      ref="fileInput"
      type="file"
      hidden
      multiple
      @change="onFilesChosen"
    />
    <input ref="videoInput" type="file" accept="video/*" hidden multiple @change="onFilesChosen" />
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
    <div class="vue-composer-input">
      <ComposerPermissionNotice
        :key="`${active?.id}:${chat.openRevision.value}`"
        :message="sendBlockedReason"
      />
      <ComposerEditor
        ref="editor"
        :initial="editorInitial"
        :desktop="desktop"
        :spellcheck="preferences.setting('spellcheck')"
        :reason="sendBlockedReason"
        :disabled="editorDisabled"
        :placeholder="
          chat.loading.value && !canSend ? '正在打开会话…' : '输入消息'
        "
        @change="receiveDraft"
        @input="onInput"
        @key="keys"
        @blur="saveDraft"
        @files="selectFiles"
      />
    </div>
    <div class="vue-composer-footer">
      <div class="vue-composer-tools" role="group" aria-label="消息工具">
        <button
          type="button"
          class="ui-icon-button"
          aria-label="表情"
          title="表情"
          :disabled="!canSend"
          :aria-expanded="emojiOpen"
          @click="emojiOpen = !emojiOpen"
        >
          <UiIcon name="emoji" />
        </button>
        <button
          type="button"
          class="ui-icon-button"
          aria-label="截图"
          title="截图"
          :disabled="!canSend || sendingMedia || screenshot.busy.value"
          @click="captureScreen"
        >
          <UiIcon name="screenshot" />
        </button>
        <button
          type="button"
          class="ui-icon-button"
          aria-label="图片 / 附件"
          title="图片 / 附件"
          :disabled="!canSend"
          @click="openFilePicker(fileInput)"
        >
          <UiIcon name="paperclip" />
        </button>
        <button type="button" class="ui-icon-button" aria-label="发送视频" title="发送视频"
          :disabled="!canSend" @click="openFilePicker(videoInput)">
          <UiIcon name="video" />
        </button>
        <button
          type="button"
          class="ui-icon-button"
          aria-label="拍照"
          title="拍照"
          :disabled="!canSend"
          @click="captureMode = 'camera'"
        >
          <UiIcon name="camera" />
        </button>
        <button
          type="button"
          class="ui-icon-button"
          aria-label="录音"
          title="录音"
          :disabled="!canSend"
          @click="captureMode = 'voice'"
        >
          <UiIcon name="microphone" />
        </button>
        <button
          v-if="active?.type === 'group'"
          type="button"
          class="ui-icon-button"
          aria-label="@"
          title="艾特群成员"
          :disabled="!canSend"
          :aria-expanded="mentionOpen"
          @click="mentions()"
        >
          <UiIcon name="at" />
        </button>
        <button
          type="button"
          class="ui-icon-button"
          aria-label="名片"
          title="名片"
          :disabled="!canSend"
          @click="card()"
        >
          <UiIcon name="contactCard" />
        </button>
        <button
          v-if="chat.me.value?.internal_staff === true && active?.type === 'direct'"
          type="button"
          class="ui-icon-button"
          aria-label="窗口抖动"
          title="窗口抖动"
          :disabled="!canSend || shakeSending"
          @click="shake"
        >
          <UiIcon name="shake" />
        </button>
      </div>
      <div class="composer-send-bar">
        <template v-if="inlineAttachments">
          <label v-if="inlineImages" class="composer-original-media">
            <input
              v-model="original"
              type="checkbox"
              :disabled="sendingMedia || !!mediaJob"
            />
            发送原图
          </label>
          <span v-if="transfer" class="composer-transfer" role="status">{{
            transfer
          }}</span>
          <button
            v-if="sendingMedia"
            class="ui-text-button"
            type="button"
            @click="controller?.abort()"
          >
            停止后续发送
          </button>
          <button
            v-else
            class="ui-text-button"
            type="button"
            @click="cancelInlineAttachments"
          >
            取消附件
          </button>
        </template>
        <div class="composer-send-control">
          <button
            type="submit"
            class="primary semi-button semi-button-primary vue-composer-send"
            :aria-describedby="
              sendBlockedReason ? 'composer-blocked-reason' : undefined
            "
            :disabled="
              inlineAttachments
                ? sendingMedia || (!canSend && !mediaJob)
                : !canSend || !draft.trim()
            "
          >
            {{ inlineAttachments && sendingMedia ? "发送中…" : "发送" }}
          </button>
          <ComposerSendMenu
            v-if="desktop"
            :key="active?.id"
            :modifier="modifierSend"
            @change="changeSendMode"
          />
        </div>
      </div>
    </div>
  </form>
  <BaseDialog
    v-if="attachmentDialog"
    :title="
      mediaJob && active?.id !== mediaJob.conversation
        ? '发送附件 · 原会话'
        : '发送附件'
    "
    @close="!sendingMedia && cleanupFiles()"
    ><div class="vue-media-previews">
      <figure v-for="(file, index) in modalFiles" :key="index">
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
      ><button class="primary" :disabled="sendingMedia" @click="upload()">
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

<style scoped>
.vue-composer {
  display: flex;
  flex-direction: column;
  position: relative;
  flex: none;
  gap: 6px;
  padding: 8px 12px max(9px, env(safe-area-inset-bottom));
  background: var(--ui-surface);
  border-top: 1px solid var(--ui-line);
}
.vue-composer-input {
  position: relative;
  min-inline-size: 0;
}
.vue-composer-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  min-inline-size: 0;
}
.vue-composer-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  min-inline-size: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.vue-composer-tools .ui-icon-button {
  flex: 0 1 37px;
  inline-size: 37px;
  min-inline-size: 24px;
  block-size: 36px;
  font-size: 20px;
}
.vue-composer-tools .ui-icon-button:focus-visible {
  outline-offset: -2px;
}
.vue-composer-send.primary {
  flex: none;
  margin-inline-start: auto;
  inline-size: 76px;
  block-size: 36px;
  white-space: nowrap;
}
.composer-send-bar {
  display: flex;
  flex: none;
  margin-inline-start: auto;
}
.composer-send-control {
  display: flex;
  margin-inline-start: auto;
}
.composer-desktop {
  gap: 8px;
  padding: 0 14px 10px;
}
.composer-desktop .vue-composer-footer {
  display: contents;
}
.composer-desktop .vue-composer-tools {
  order: -1;
  min-height: 41px;
  gap: 4px;
  padding-block: 2px;
  border-bottom: 1px solid var(--ui-line);
}
.composer-desktop .vue-composer-tools .ui-icon-button {
  flex: 0 0 33px;
  inline-size: 33px;
  block-size: 33px;
  font-size: 19px;
}
.composer-desktop .composer-send-bar {
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-inline-start: 0;
}
.composer-desktop .vue-composer-send.primary {
  margin: 0;
  inline-size: 68px;
  block-size: 34px;
  min-block-size: 34px;
  border-radius: 6px 0 0 6px;
  font-size: 13px;
}
.composer-original-media {
  display: flex;
  flex: none;
  align-items: center;
  gap: 5px;
  color: var(--ui-muted);
  font-size: 12px;
}
.composer-original-media input {
  accent-color: var(--ui-primary);
}
.composer-transfer {
  min-width: 0;
  color: var(--ui-muted);
  font-size: 11px;
}
.composer-send-bar > .ui-text-button {
  flex: none;
  padding-inline: 6px;
  font-size: 12px;
}
.vue-reply {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 6px 4px 9px;
  border-inline-start: 2px solid var(--ui-primary);
  background: var(--ui-surface-soft);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.vue-reply button {
  flex: none;
}
.vue-outbox {
  flex: none;
  max-height: 100px;
  overflow: auto;
  padding: 4px 10px;
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
  font-size: 12px;
}
.vue-outbox > div {
  display: flex;
  gap: 5px;
  align-items: center;
  overflow-wrap: anywhere;
}
.vue-outbox span {
  flex: 1;
  min-width: 0;
}
.vue-outbox button {
  flex: none;
  padding: 4px 6px;
}
.vue-mention-picker {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 9px;
  width: min(354px, calc(100% - 18px));
  max-height: min(330px, 52vh);
  z-index: 7;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--ui-line);
  border-radius: 8px;
  background: var(--ui-surface);
  box-shadow: var(--ui-popover-shadow);
  display: flex;
  flex-direction: column;
}
.vue-mention-picker input {
  display: block;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--ui-line);
  border-radius: 6px;
  background: var(--ui-surface-soft);
  color: var(--ui-text);
}
.vue-mention-picker button {
  background: transparent;
  text-align: start;
}
.vue-media-previews {
  display: flex;
  gap: 10px;
  overflow-x: auto;
}
.vue-media-previews figure {
  flex: 0 0 min(190px, 72vw);
  padding: 6px;
  border: 1px solid var(--ui-line);
  border-radius: 6px;
}
.vue-media-previews img {
  max-height: 180px;
  object-fit: contain;
  border-radius: 4px;
}
.vue-media-previews figcaption {
  margin-top: 5px;
  color: var(--ui-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
@media (max-width: 760px) {
  .vue-composer {
    padding-inline: 8px;
  }
  .vue-composer-footer {
    gap: 6px;
  }
  .vue-composer-tools {
    gap: 0;
  }
  .vue-composer-tools .ui-icon-button {
    flex-basis: 33px;
    inline-size: 33px;
    font-size: 19px;
  }
  .vue-composer-send.primary {
    inline-size: 54px;
    padding-inline: 4px;
  }
}
</style>
