package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/** Deliberately delayed loopback fixture only; no account login or production traffic. */
internal object WorkTaskPerformanceChecks {
    fun run(probe: Instrumentation, args: Bundle) {
        val result = Bundle(); val report = JSONObject(); var activity: MainActivity? = null
        try {
            val base = requireNotNull(args.getString("base"))
            require(Regex("http://(?:127\\.0\\.0\\.1|10\\.0\\.2\\.2):[0-9]+/api/v2").matches(base))
            val host = base.removeSuffix("/api/v2")
            fun stats() = JSONObject(URL("$host/stats").readText())
            fun waitUntil(check: () -> Boolean) {
                val until = System.currentTimeMillis() + 12000
                while (!check()) { check(System.currentTimeMillis() < until) { "Fixture/UI did not settle" }; Thread.sleep(30) }
            }
            fun <T> ui(action: () -> T): T {
                val value = AtomicReference<T>(); val error = AtomicReference<Throwable>()
                probe.runOnMainSync { try { value.set(action()) } catch (failure: Throwable) { error.set(failure) } }
                error.get()?.let { throw it }; return value.get()
            }
            GoV2Ids.context = probe.targetContext.applicationContext
            val client = ApiClient(base).apply { token = "isolated-work-performance" }
            val user = GoV2Ids.local(base,"user","11111111-1111-4111-8111-111111111111")
            val record = GoV2Ids.local(base,"record","22222222-2222-4222-8222-222222222222")
            val payload = client.workTaskRecord(record)
            val initial = stats()
            check(initial.getInt("grant_batches") == 1 && initial.getInt("single_grants") == 0)
            report.put("initialQuestionGrants", initial.getInt("grant_batches")).put("questionCount",payload.getJSONArray("questions").length())
            activity = probe.startActivitySync(Intent(probe.targetContext,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val page = activity
            fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
            ui {
                field("apiBaseUrl").set(page,base);field("api").set(page,client);field("currentUserId").setInt(page,user);field("tasksVisible").setBoolean(page,true)
                val content = LinearLayout(page).apply { orientation=LinearLayout.VERTICAL }
                field("content").set(page,content);page.setContentView(content)
                MainActivity::class.java.getDeclaredMethod("showWorkTaskAnswer",JSONObject::class.java).apply { isAccessible=true }.invoke(page,payload)
            }
            waitUntil { ui { page.findViewById<ImageView>(R.id.work_question_image)?.isAttachedToWindow == true } }
            val beforeWrites = stats().getInt("progress_writes")
            val first = System.nanoTime()
            ui { page.findViewById<android.view.View>(R.id.work_answer_yes).performClick() }
            val firstMs = (System.nanoTime()-first)/1_000_000
            check(ui { page.findViewById<TextView>(R.id.work_progress).text.toString().startsWith("第 2 / ") })
            check(firstMs < 700) { "Selection waited $firstMs ms for a 1200 ms save" }
            repeat(2) { ui { page.findViewById<android.view.View>(R.id.work_answer_no).performClick() } }
            check(ui { page.findViewById<TextView>(R.id.work_progress).text.toString().startsWith("第 4 / ") })
            waitUntil { stats().getInt("saved_answers") >= 3 }
            val synced = stats()
            check(synced.getInt("progress_writes")-beforeWrites <= 2)
            check(synced.getInt("grant_batches") == initial.getInt("grant_batches")) { "Progress save re-authorized every question image" }
            check(synced.getInt("single_grants") == 0) { "Captured task session discarded valid image authorizations" }
            report.put("firstSelectionMsWith1200msServerDelay",firstMs).put("threeSelectionsSaveBatches",synced.getInt("progress_writes")-beforeWrites)

            val panel = ui { field("workQuestionImagePanel").get(page) as QuestionImagePanel }
            val cachedURL = "$host/fixture/cache-green.png"
            ui { panel.bind("cache-one",cachedURL,"缓存测试") }
            waitUntil { ui { page.findViewById<ImageView>(R.id.work_question_image).drawable != null } }
            val greenDownloads = stats().getInt("green_downloads")
            ui { panel.bind("other","$host/fixture/fast-blue.png","另一题") }
            waitUntil { ui { (page.findViewById<ImageView>(R.id.work_question_image).drawable as? BitmapDrawable)?.bitmap?.getPixel(0,0) == Color.BLUE } }
            val revisit = System.nanoTime()
            ui { panel.bind("cache-one",cachedURL,"返回已加载题目") }
            waitUntil { ui { (page.findViewById<ImageView>(R.id.work_question_image).drawable as? BitmapDrawable)?.bitmap?.getPixel(0,0) == Color.GREEN } }
            check(stats().getInt("green_downloads")==greenDownloads)
            report.put("revisitWithoutAnotherDownload",true).put("revisitMs",(System.nanoTime()-revisit)/1_000_000)

            ui { panel.bind("slow","$host/fixture/slow-red.png","慢请求") }
            waitUntil { stats().getInt("slow_started") > 0 }
            val switch = System.nanoTime()
            ui { repeat(12) { panel.bind("skip-$it","$host/fixture/slow-red.png?skip=$it","跳题") };panel.bind("blue","$host/fixture/fast-blue.png?uncached-current=true","当前题") }
            waitUntil { ui { (page.findViewById<ImageView>(R.id.work_question_image).drawable as? BitmapDrawable)?.bitmap?.getPixel(0,0) == Color.BLUE } }
            val switchMs = (System.nanoTime()-switch)/1_000_000
            check(switchMs<1500) { "Old image backlog blocked current question for $switchMs ms" }
            Thread.sleep(2300)
            check(ui { (page.findViewById<ImageView>(R.id.work_question_image).drawable as? BitmapDrawable)?.bitmap?.getPixel(0,0) == Color.BLUE })
            report.put("rapidSwitchMs",switchMs).put("lateImageCannotReplaceCurrentQuestion",true)
            result.putString("report",report.toString());probe.finish(Activity.RESULT_OK,result)
        } catch (error: Throwable) {
            result.putString("error",error.stackTraceToString());result.putString("report",report.toString());probe.finish(Activity.RESULT_CANCELED,result)
        } finally { activity?.let { page -> probe.runOnMainSync { page.finish() } } }
    }
}
