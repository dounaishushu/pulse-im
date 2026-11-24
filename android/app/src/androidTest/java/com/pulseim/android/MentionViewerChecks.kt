package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executor

/** Shipping HTTP client, UUID adapter, name directory, text views and quote bindings. */
internal object MentionViewerChecks {
    fun run(probe: Instrumentation, args: Bundle) {
        val result = Bundle(); val report = JSONObject(); val checks = JSONArray()
        fun passed(name: String) { checks.put(name) }
        fun ui(action: () -> Unit) = probe.runOnMainSync(action)
        try {
            val base = requireNotNull(args.getString("base"))
            require(Regex("http://(?:127\\.0\\.0\\.1|10\\.0\\.2\\.2):[0-9]+/api/v2").matches(base))
            GoV2Ids.context = probe.targetContext.applicationContext
            val target = GoV2Ids.local(base, "user", "00000002-eeee-4eee-8eee-eeeeeeeeeeee")
            val author = GoV2Ids.local(base, "user", "00000001-eeee-4eee-8eee-eeeeeeeeeeee")
            val conversation = GoV2Ids.local(base, "conversation", "00009000-eeee-4eee-8eee-eeeeeeeeeeee")
            for (viewer in 1..3) {
                val client = ApiClient(base).apply { token = "mention-viewer-$viewer" }
                val profile = client.me(); val actor = profile.getInt("id")
                var nickname = profile.getString("nickname")
                var owner: ContactNameDirectory.Scope? = ContactNameDirectory.Scope(base, client.token!!, actor)
                val names = ContactNameDirectory({ owner }, Executor { it.run() }, { work -> work() }, { _, _ -> error("No per-mention profile request is allowed") }, {}, { 0L })
                val page = client.contactNamePage(1).getJSONArray("items")
                check(names.seed(owner!!, (0 until page.length()).map { page.getJSONObject(it) }))
                val resolve: (Int, String) -> String = { id, fallback -> if (id == actor) nickname else names.resolve(id, fallback) }
                val rows = client.historyPage(conversation, size = 20).items
                val parent = rows.first { it.getInt("id") == 1 }
                val reply = rows.first { it.getInt("id") == 2 }.getJSONObject("body").getJSONObject("reply_to")
                val body = parent.getJSONObject("body"); val rawBody = body.toString(); val rawQuote = reply.toString()
                val expected = when (viewer) { 1 -> "@发送方私有备注 你好"; 2 -> "@被提及者昵称 你好"; else -> "@旁观者自己的备注 你好" }
                val quoteAuthor = when (viewer) { 1 -> "发送者昵称"; 2 -> "接收方给作者的备注"; else -> "旁观者给作者的备注" }
                val current = MentionDisplayText.text(body, resolve)
                if (args.getString("baseline") != "true") {
                    check(body.getJSONArray("mention_users").getJSONObject(0).getInt("user_id") == target)
                    check(current == expected) { "viewer $viewer saw $current" }
                    check(MentionDisplayText.text(reply, resolve) == expected)
                }
                report.put("viewer$viewer", current)
                if (viewer == 2 && args.getString("baseline") == "true") continue
                if (args.getString("baseline") == "true") continue
                passed("viewer $viewer resolves the same verified target in body and hydrated reply")
                lateinit var root: LinearLayout; lateinit var text: TextView; lateinit var quote: MessageReferenceStrip
                ui {
                    root = LinearLayout(probe.targetContext).apply { orientation = LinearLayout.VERTICAL }
                    text = TextView(probe.targetContext).apply { id = R.id.chat_message_text; this.text = body.getString("text") }
                    root.addView(text)
                    ContactNameLabels.bindMessage(root, parent, resolve)
                    quote = MessageReferenceStrip(probe.targetContext, reply.getString("sender_name"), reply.getString("text"), iosGroup = true, embedded = true)
                    ContactNameLabels.bind(quote.titleLabel, reply.getInt("sender_id"), reply.getString("sender_name"), resolve, "回复 ")
                    ContactNameLabels.bindText(quote.summaryLabel, reply, resolve, summary = true)
                    root.addView(quote)
                    check(text.text.toString() == expected && quote.summaryLabel.text.toString() == expected)
                    check(quote.titleLabel.text.toString() == "回复 $quoteAuthor")
                }
                passed("viewer $viewer sees their own names in native message, quote author and composer preview")
                val summary = messageSummary(parent, actor, "fixture", resolve)
                check(summary.endsWith(expected))
                passed("viewer $viewer conversation preview uses the same name resolver")
                ui {
                    if (viewer == 2) nickname = "我现在的新昵称" else names.remember(target, "新的个人备注", "被提及者昵称")
                    ContactNameLabels.refresh(root, resolve)
                    val next = if (viewer == 2) "@我现在的新昵称 你好" else "@新的个人备注 你好"
                    check(text.text.toString() == next && quote.summaryLabel.text.toString() == next)
                    if (viewer != 1) {
                        names.remember(author, "作者新备注", "发送者昵称")
                        ContactNameLabels.refresh(root, resolve)
                        check(quote.titleLabel.text.toString() == "回复 作者新备注")
                    }
                    if (viewer != 2) {
                        names.remember(target, "", "被提及者昵称"); ContactNameLabels.refresh(root, resolve)
                        check(text.text.toString() == "@被提及者昵称 你好")
                    }
                }
                passed("viewer $viewer live nickname/remark edits and clearing update existing native text and quotes")
                check(body.toString() == rawBody && reply.toString() == rawQuote)
                val draft = ChatDraft.cleanReply(reply)!!
                check(draft.getString("text") == "@发送方私有备注 你好" && MentionDisplayText.text(draft, resolve) == MentionDisplayText.text(reply, resolve))
                check(draft.getJSONArray("mention_user_ids").getInt(0) == target)
                passed("viewer $viewer drafts retain raw text and immutable IDs instead of saving rendered private names")
                owner = ContactNameDirectory.Scope(base, "different-account", actor + 100)
                check(names.resolve(target, "被提及者昵称") == "被提及者昵称")
                passed("viewer $viewer previous-account notes cannot be reused after an account switch")
            }
            if (args.getString("baseline") != "true") {
                fun body(text: String, label: String, ids: JSONArray = JSONArray().put(target)): JSONObject = JSONObject().put("text", text).put("mention_user_ids", ids)
                    .put("mention_users", JSONArray().put(JSONObject().put("user_id", target).put("nickname", "公开昵称").put("labels", JSONArray().put(label))))
                val resolve: (Int, String) -> String = { _, _ -> "本人的备注" }
                check(MentionDisplayText.text(JSONObject().put("text", "手写 @发送方私有备注"), resolve) == "手写 @发送方私有备注")
                check(MentionDisplayText.text(body("@发送方私有备注X mail@发送方私有备注 @发送方私有备注", "发送方私有备注"), resolve) == "@发送方私有备注X mail@发送方私有备注 @本人的备注")
                check(MentionDisplayText.text(body("@特殊[备注]($)+ 你好", "特殊[备注]($)+"), resolve) == "@本人的备注 你好")
                check(MentionDisplayText.text(body("@发送方私有备注", "发送方私有备注", JSONArray().put(author)), resolve) == "@发送方私有备注")
                passed("only verified targets and complete @ tokens are replaced; literal regex characters and unrelated text remain safe")
                check(MentionDisplayText.text(body("🙂\u00A0@备注\uFEFF下一句\n@备注", "备注"), resolve) == "🙂\u00A0@本人的备注\uFEFF下一句\n@本人的备注")
                check(MentionDisplayText.text(body("@值 班员 你好", "值 班员"), resolve) == "@本人的备注 你好")
                passed("emoji, Unicode whitespace, multiple lines and names containing spaces retain correct token boundaries")
                val legacy = body("@旧备注 你好", "旧备注").put("mentions", JSONArray().put("00000002-eeee-4eee-8eee-eeeeeeeeeeee"))
                legacy.getJSONArray("mention_users").getJSONObject(0).put("user_id", "00000002-eeee-4eee-8eee-eeeeeeeeeeee")
                check(MentionDisplayText.text(legacy, resolve) == "@本人的备注 你好")
                passed("older cached UUID mention metadata uses its verified local target mapping without another request")
                ui {
                    val card = LinearLayout(probe.targetContext)
                    val caption = TextView(probe.targetContext).apply { id = R.id.chat_image_caption; text = "@备注" }
                    card.addView(caption)
                    val image = JSONObject().put("type", "image").put("status", "sent").put("body", body("@备注", "备注"))
                    ContactNameLabels.bindMessage(card, image, resolve)
                    check(caption.text.toString() == "@本人的备注")
                    caption.text = "消息已撤回"
                    ContactNameLabels.bindMessage(card, JSONObject(image.toString()).put("status", "recalled"), resolve)
                    ContactNameLabels.refresh(card, resolve)
                    check(caption.text.toString() == "消息已撤回")
                }
                passed("image captions share the viewer resolver and recalled content is not rebound")
                val unavailable = JSONObject().put("id", 1).put("unavailable", true)
                check(ChatDraft.cleanReply(unavailable) == null)
                passed("unavailable original messages cannot restore a private quote into a draft")
            }
            report.put("checks", checks).put("passed", checks.length())
            result.putString("result", "passed")
        } catch (error: Throwable) {
            result.putString("result", "failed"); result.putString("error", error.stackTraceToString())
        }
        result.putString("report", report.toString())
        probe.finish(if (result.getString("result") == "passed") Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}
