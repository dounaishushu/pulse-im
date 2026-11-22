<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef, watch } from "vue";
import { chatKey } from "../../composables/useChat";
import ContextMenu from "../../components/ContextMenu.vue";
import UiIcon from "../../components/UiIcon.vue";
import type { Group, Member, Message } from "../../api/types";
const props = defineProps<{ message: Message; point: { x: number; y: number }; anchor: HTMLElement }>(),
  emit = defineEmits<{ close: [] }>(),
  chat = inject(chatKey)!;
const state = shallowRef<{ profile: Group; items: Member[] } | null>(null),
  busy = shallowRef(false),
  feedback = shallowRef("正在校验成员权限…");
const controller = new AbortController(),
  session = chat.client.token,
  cid = props.message.conversation_id,
  uid = props.message.sender_id;
const current = () =>
  !controller.signal.aborted && chat.client.token === session && !chat.locked.value && chat.active.value?.id === cid;
watch([() => chat.active.value?.id, chat.locked], () => { if (!current()) emit("close"); });
const target = computed(() => state.value?.items.find((row) => row.id === uid));
const allowed = computed(
  () =>
    state.value?.profile.can_manage &&
    target.value &&
    target.value.role !== "owner" &&
    uid !== chat.me.value?.id &&
    (state.value.profile.is_owner || target.value.role === "member"),
);
async function load() {
  const fresh = await chat.api<{ profile: Group; items: Member[] }>(
    `/conversations/members/context?conversation_id=${cid}&user_id=${uid}`,
    {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    },
  );
  if (current()) {
    state.value = fresh;
    feedback.value = "";
  }
  return fresh;
}
async function manage(action: "mute" | "remove") {
  if (busy.value || !current() || !allowed.value) return;
  const minutes = target.value?.is_muted ? 0 : -1;
  if (action === "remove" && !confirm("将此成员移出群聊？")) return;
  busy.value = true;
  try {
    await load();
    if (!current() || !allowed.value) throw Error("成员权限已变化，请重新打开");
    await chat.post("/conversations/members/" + action, {
      conversation_id: cid,
      user_id: uid,
      ...(action === "mute" ? { minutes } : {}),
    });
    if (current()) {
      void chat.summary([cid]);
      emit("close");
    }
  } catch (cause) {
    if (current())
      feedback.value = cause instanceof Error ? cause.message : "操作失败";
  } finally {
    busy.value = false;
  }
}
function mention() {
  if (busy.value || !current() || !chat.canSend.value) return;
  chat.mentionRequest.value = {
    user: uid,
    name: chat.contactName(uid, target.value?.nickname || props.message.sender_name),
    revision: Date.now(),
  };
  emit("close");
}
void load().catch((cause) => {
  if (current())
    feedback.value =
      cause instanceof Error ? cause.message : "无法读取成员信息";
});
onScopeDispose(() => controller.abort());
</script>
<template>
  <ContextMenu compact label="群成员操作" :point="point" :anchor="anchor" @close="emit('close')">
    <p v-if="feedback" class="member-menu-feedback" role="status">{{ feedback }}</p>
    <button
      v-if="state?.profile.can_manage"
      role="menuitem"
      :disabled="busy || !allowed"
      @click="manage('mute')"
    >
      <UiIcon :name="target?.is_muted ? 'volume' : 'mute'" />{{ target?.is_muted ? "解除禁言" : "禁言" }}
    </button>
    <button role="menuitem" :disabled="busy || !chat.canSend.value" @click="mention">
      <UiIcon name="group" />@ 此成员
    </button>
    <button
      v-if="state?.profile.can_manage"
      role="menuitem"
      :disabled="busy || !allowed"
      @click="manage('remove')"
    >
      <UiIcon name="delete" />踢出群聊
    </button>
  </ContextMenu>
</template>
<style scoped>
.member-menu-feedback { padding: 5px 12px; margin: 0; font-size: 12px; color: var(--ui-muted); }
</style>
