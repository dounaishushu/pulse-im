package com.pulseim.android

import android.content.Context
import org.json.JSONObject

/** A ticket makes older queued saves unable to overwrite a lifecycle flush or a new editor. */
internal class ChatDraftStore(context: Context) {
    private val app = context.applicationContext
    data class Owner(val scope: String, val conversation: Int) {
        init { require(conversation > 0) }
        val namespace: String get() = "draft.$conversation"
    }
    class Write internal constructor(private val app: Context, private val ticket: LocalAccountStore.Ticket,
                                     private val value: JSONObject?) {
        fun commit(): Boolean = if (value == null) LocalAccountStore.remove(app, ticket, "snapshot")
            else LocalAccountStore.write(app, ticket, "snapshot", value)
    }
    fun owner(endpoint: String, userId: Int, conversation: Int) = Owner(LocalAccountStore.scope(endpoint, userId), conversation)
    fun read(owner: Owner): ChatDraft? {
        val raw = LocalAccountStore.read(app, owner.scope, owner.namespace, "snapshot") ?: return null
        return checkNotNull(ChatDraft.fromJSON(raw)) { "本地草稿格式无效" }
    }
    fun prepare(owner: Owner, draft: ChatDraft): Write = Write(app, LocalAccountStore.ticket(owner.scope, owner.namespace),
        if (draft.empty) null else draft.toJSON())
}
