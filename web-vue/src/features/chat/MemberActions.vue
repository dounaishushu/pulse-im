<script setup lang="ts">
import { computed, inject, onScopeDispose, shallowRef } from "vue";
import { chatKey } from "../../composables/useChat";
import BaseDialog from "../../components/BaseDialog.vue";
import type { Group, Member, Message } from "../../api/types";
const props = defineProps<{ message: Message }>(),
  emit = defineEmits<{ close: [] }>(),
  chat = inject(chatKey)!;
const state = shallowRef<{ profile: Group; items: Member[] } | null>(null),
  busy = shallowRef(false),
  feedback = shallowRef("正在校验成员权限…");
const controller = new AbortController(),
  cid = props.message.conversation_id,
  uid = props.message.sender_id;
const current = () =>
  !controller.signal.aborted && chat.active.value?.id === cid;
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
  if (!current() || !chat.canSend.value) return;
  chat.mentionRequest.value = {
    user: uid,
    name: props.message.sender_name || "",
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
  <BaseDialog title="群成员操作" :busy="busy" @close="emit('close')"
    ><p>{{ chat.contactName(message.sender_id, message.sender_name) }}</p>
    <p role="status">{{ feedback }}</p>
    <div class="vue-action-list">
      <button :disabled="!chat.canSend.value" @click="mention">@ 此成员</button
      ><button
        @click="
          chat.contactId.value = message.sender_id;
          chat.contactContext.value = cid;
          chat.contactCard.value = null;
          chat.panel.value = 'contacts';
          emit('close');
        "
      >
        查看个人资料</button
      ><button
        v-if="state?.profile.can_manage"
        :disabled="busy || !allowed"
        @click="manage('mute')"
      >
        {{ target?.is_muted ? "解除禁言" : "永久禁言" }}</button
      ><button
        v-if="state?.profile.can_manage"
        :disabled="busy || !allowed"
        @click="manage('remove')"
      >
        移出群聊
      </button>
    </div></BaseDialog
  >
</template>
