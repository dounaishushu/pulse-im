package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real adapter and MainActivity render path, with held optional requests. */
class ChatFirstPaintProbe : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        var activity: MainActivity? = null
        val releases = mutableListOf<CountDownLatch>()
        val checks = JSONArray()
        try {
            check(targetContext.packageName.endsWith(".scrollprobe")) { "Requires isolated application ID" }
            GoV2Ids.context = targetContext.applicationContext
            activity = startActivitySync(Intent().setClassName(targetContext.packageName, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val host = activity
            fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
            fun get(name: String): Any? = ChatProbeAccess.get(host, name)
            fun set(name: String, value: Any?) = ChatProbeAccess.set(host, name, value)
            fun ui(action: () -> Unit) = runOnMainSync(action)
            fun settle() { waitForIdleSync(); SystemClock.sleep(100); waitForIdleSync() }
            fun until(condition: () -> Boolean) {
                val deadline = SystemClock.uptimeMillis() + 6000
                while (SystemClock.uptimeMillis() < deadline) { settle(); var ready = false; ui { ready = condition() }; if (ready) return }
                var detail=""
                ui{detail="cid=${get("activeConversationId")}; ready=${get("chatHistoryReady")}; version=${get("goMembershipVersion")}; rows=${(get("currentMessages") as? LinearLayout)?.childCount}; invalid=${get("goChatInvalidated")}"}
                error("Timed out waiting for chat render: $detail")
            }
            val base = get("apiBaseUrl") as String
            check(base.startsWith("http://127.0.0.1:9/")) { "Requires local-only API" }
            val token = "isolated-first-paint"
            val viewerWire = UUID.randomUUID().toString(); val viewer = GoV2Ids.local(base,"user",viewerWire)
            val senderWire = UUID.randomUUID().toString()
            for (kind in listOf("direct","group")) {
                val cidWire = UUID.randomUUID().toString(); val cid = GoV2Ids.local(base,"conversation",cidWire)
                val media = UUID.randomUUID().toString(); val released = CountDownLatch(1); releases += released
                val entryClass = Class.forName("com.pulseim.android.MainActivity\$ChatEntry")
                val entry = entryClass.getDeclaredConstructor(Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,String::class.java,String::class.java).apply { isAccessible=true }.newInstance(cid,viewer,token,base)
                @Suppress("UNCHECKED_CAST") fun future(name:String) = entryClass.getDeclaredField(name).apply { isAccessible=true }.get(entry) as CompletableFuture<ChatHistoryPage>
                val page = future("page"); val preview = future("preview")
                val rows = JSONArray((1..20).map { seq -> JSONObject().put("id",UUID.randomUUID().toString()).put("seq",seq.toString()).put("event_seq",seq.toString()).put("version","1")
                    .put("conversation_id",cidWire).put("sender_id",senderWire).put("sender",JSONObject().put("name","成员"))
                    .put("kind",if(seq==20)"image" else "text").put("body",if(seq==20)"" else "已授权消息 $seq").put("request_id","fixture-$seq")
                    .put("content",if(seq==20)JSONObject().put("media",JSONObject().put("id",media).put("bytes","100").put("mime","image/png").put("filename","photo.png").put("width",320).put("height",240)) else JSONObject())
                    .put("created_at","2026-11-16T00:00:00Z").put("updated_at","2026-11-16T00:00:00Z") })
                val paths = java.util.Collections.synchronizedList(mutableListOf<String>())
                val adapter=GoV2Api(base,{token},{1L}) { path,_,body,_ ->
                    paths += path
                    when {
                        path=="/me" -> JSONObject().put("user_id",viewerWire)
                        path.contains("/history?") -> JSONObject().put("items",rows).put("membership_version","1").put("snapshot_max_seq","20").put("next_after_seq","0").put("clear_seq","0").put("visible_from_seq","1").put("has_more",false)
                        path=="/media/grants" -> {
                            check(released.await(10,TimeUnit.SECONDS)) { "Probe failed to release media request" }
                            check(body?.getJSONArray("media_ids")?.getString(0)==media)
                            JSONObject().put("items",JSONArray().put(JSONObject().put("id",media).put("access",JSONObject().put("content_path","/api/v2/media-grants/"+"a".repeat(64)+"/content").put("expires_in",120))))
                        }
                        else -> error("Unexpected fixture path $path")
                    }
                }
                val fixtureClient=ApiClient(base).apply { this.token=token;onHistoryPreview={preview.complete(it)} }
                ApiClient::class.java.getDeclaredField("go\$delegate").apply{isAccessible=true}.set(fixtureClient,lazyOf(adapter))
                ui {
                    (get("api") as ApiClient).token=token;set("currentUserId",viewer);set("preparedChatHistory",entry)
                    val info=JSONObject().put("id",cid).put("type",kind).put("name","首屏测试").put("can_send",true).put("can_publish",true).put("membership_version","1")
                        .put("cleared_before_message_id",0).put("member_count",2).put("can_manage",false).put("peer_user_id",GoV2Ids.local(base,"user",senderWire))
                    MainActivity::class.java.getDeclaredMethod("showChat",String::class.java,String::class.java,JSONObject::class.java).apply{isAccessible=true}.invoke(host,"测试","chat",info)
                }
                val worker=Thread {
                    try { page.complete(fixtureClient.historyPage(cid,size=20)) }
                    catch(error:Throwable){page.completeExceptionally(error)}
                }.apply{start()}
                try { until { (get("currentMessages") as? LinearLayout)?.findViewWithTag<View>(19)!=null } }
                catch(error:Throwable){
                    val failure=if(page.isCompletedExceptionally)runCatching{page.join()}.exceptionOrNull()?.stackTraceToString() else "waiting"
                    error("$kind: ${error.message}; preview=${preview.isDone}; full=$failure; paths=$paths")
                }
                lateinit var retained:View;lateinit var input:EditText;lateinit var messages:LinearLayout
                ui {
                    messages=get("currentMessages") as LinearLayout;retained=messages.findViewWithTag(19)
                    check(!page.isDone) { "First paint waited for optional media" }
                    check(host.findViewById<View>(R.id.chat_history_loading).visibility==View.GONE)
                    input=host.findViewById(R.id.chat_message_input);input.setText("输入中的草稿")
                }
                checks.put("$kind: authorized messages paint while media authorization is stalled")
                checks.put("$kind: initial spinner ends at the first readable frame")
                SystemClock.sleep(300);ui{check(retained.parent!=null);check(input.text.toString()=="输入中的草稿")}
                checks.put("$kind: slow media leaves messages and draft visible")
                released.countDown();worker.join(5000);page.get(5,TimeUnit.SECONDS)
                until { get("chatHistoryReady")==true }
                ui {
                    check(messages===get("currentMessages") && messages.findViewWithTag<View>(19)===retained) { "Unchanged text row was replaced" }
                    check(input.text.toString()=="输入中的草稿")
                }
                checks.put("$kind: enrichment retains unchanged text views and composer draft")
                check(paths.count{it.contains("/history?")}==1 && paths.count{it=="/media/grants"}==1)
                checks.put("$kind: first page uses one history read and one media batch")
            }
            val report=JSONObject().put("passed",checks.length()).put("checks",checks)
            java.io.File(targetContext.filesDir,"chat-first-paint-results.json").writeText(report.toString(2))
            finish(Activity.RESULT_OK,Bundle().apply{putString("checks",report.toString())})
        }catch(error:Throwable){finish(Activity.RESULT_CANCELED,Bundle().apply{putString("error",error.stackTraceToString())})}
        finally { releases.forEach{it.countDown()};activity?.let{runOnMainSync{it.finish()}} }
    }
}
