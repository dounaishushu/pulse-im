package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint

/** Uses only the dedicated owned accounts; can run against the exact delivered
 * APK to distinguish its runtime contract from the current checked-in code. */
internal object MediaPerformanceChecks {
    fun run(instrumentation: Instrumentation, args: Bundle) {
        val output=Bundle();val report=JSONObject();val failures=JSONArray()
        try {
            val context=instrumentation.targetContext
            GoV2Ids.context=context.applicationContext;MobileDeviceIdentity.initialize(context)
            val prefix=requireNotNull(args.getString("prefix"));require(prefix.startsWith("rel"))
            val password=requireNotNull(args.getString("password"));val strict=args.getString("strict")=="true"
            val base="https://api.imapi.shop/api/v2"
            val a=ApiClient(base).apply{token=login(prefix+"a",password)}
            val b=ApiClient(base).apply{token=login(prefix+"b",password)}
            val me=a.me();val peer=b.me();check(me.getString("username")==prefix+"a")
            report.put("installedVersion",context.packageManager.getPackageInfo(context.packageName,0).versionName)
            fun checkOpen(name:String,cid:Int):JSONObject {
                val start=System.nanoTime();val opened=a.openConversation(cid)
                val valid=opened.optInt("id")==cid&&opened.optString("type") in listOf("direct","group","channel","favorites")
                val result=JSONObject().put("case",name).put("expectedId",cid).put("actualId",opened.optInt("id")).put("type",opened.optString("type")).put("valid",valid)
                    .put("elapsedMs",(System.nanoTime()-start)/1_000_000)
                if(!valid)synchronized(failures){failures.put(result)}
                return result
            }
            val direct=a.createDirectConversation(peer.getInt("id"));val cid=direct.getInt("id")
            val opens=JSONArray();repeat(3){opens.put(checkOpen("direct",cid))}
            a.hideConversation(cid);opens.put(checkOpen("hidden",cid))
            val saved=a.favoritesConversation();opens.put(checkOpen("favorites",saved.getInt("id")))
            val pool=Executors.newFixedThreadPool(4)
            try {
                a.hideConversation(cid)
                val tasks=(0 until 12).map{n->Callable {
                    try{checkOpen("concurrent-"+n,cid)}catch(e:Exception){JSONObject().put("case","concurrent-"+n).put("valid",false).put("error",e.message.orEmpty()).also{synchronized(failures){failures.put(it)}}}
                }}
                pool.invokeAll(tasks,40,TimeUnit.SECONDS).forEach{opens.put(it.get())}
            } finally {pool.shutdownNow()}
            report.put("opens",opens).put("failures",failures)
            checkOpen("final-direct",cid)
            if(args.getString("perf")=="true"){
                val fresh=ApiClient(base).apply{token=a.token};val cold=System.nanoTime()
                val history=fresh.historyPage(cid,233,50)
                report.put("coldHistoryMs",(System.nanoTime()-cold)/1_000_000).put("historyRows",history.items.size)
                    .put("historyImages",history.items.count{it.optString("type")=="image"})
                val jpg=File(context.filesDir,"perf-upload.jpg");check(jpg.isFile&&jpg.length()>0)
                val bitmap=Bitmap.createBitmap(960,640,Bitmap.Config.ARGB_8888);val canvas=Canvas(bitmap);val paint=Paint()
                canvas.drawColor(Color.rgb(230,245,237));paint.color=Color.rgb(20,120,90);canvas.drawRect(30f,30f,930f,160f,paint)
                paint.color=Color.WHITE;paint.textSize=42f;canvas.drawText("Android image latency",60f,115f,paint)
                listOf(0xffe87848.toInt(),0xff31a780.toInt(),0xff56a4e2.toInt(),0xffb88dd6.toInt(),0xffe7c14e.toInt()).forEachIndexed{n,color->paint.color=color;canvas.drawRect(40f+n*176,260f,192f+n*176,540f,paint)}
                val png=File(context.cacheDir,"perf-upload.png");png.outputStream().use{check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it))};bitmap.recycle()
                val samples=JSONArray()
                report.put("mediaSamples",samples)
                repeat(6){n->
                    val file=if(n<3)jpg else png;val start=System.nanoTime();val upload=a.uploadMedia(file,"image",if(n<3)"image/jpeg" else "image/png")
                    val uploaded=(System.nanoTime()-start)/1_000_000
                    val message=a.sendMediaMessage(cid,"image",upload,"android-latency-"+java.util.UUID.randomUUID())
                    samples.put(JSONObject().put("format",if(n<3)"jpeg" else "png").put("bytes",file.length()).put("uploadMs",uploaded).put("ackMs",(System.nanoTime()-start)/1_000_000).put("message",message.getInt("id")))
                }
                report.put("mediaSamples",samples)
            }
            if(args.getString("ui")=="true"){
                context.getSharedPreferences("pulse_im_session",android.content.Context.MODE_PRIVATE).edit().putString("go_api_base_url",base).commit()
                val sessions=AccountSessions(context,base);if(sessions.activeId()>0)sessions.invalidate(sessions.activeId())
                val activity=instrumentation.startActivitySync(android.content.Intent(context,MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK))
                fun waitUntil(timeout:Long,predicate:()->Boolean):Boolean{val until=System.currentTimeMillis()+timeout;while(System.currentTimeMillis()<until){var ok=false;instrumentation.runOnMainSync{ok=predicate()};if(ok)return true;Thread.sleep(100)};return false}
                check(waitUntil(15000){activity.findViewById<android.widget.EditText>(R.id.auth_account)!=null}){"login view unavailable"}
                instrumentation.runOnMainSync{
                    activity.findViewById<android.widget.EditText>(R.id.auth_account).setText(prefix+"a")
                    activity.findViewById<android.widget.EditText>(R.id.auth_password).setText(password)
                    activity.findViewById<android.view.View>(R.id.auth_primary_action).performClick()
                }
                fun find(view:android.view.View,text:String):android.view.View?{if(view is android.widget.TextView&&view.text.toString()==text)return view;if(view is android.view.ViewGroup)for(i in 0 until view.childCount)find(view.getChildAt(i),text)?.let{return it};return null}
                var peerRow:android.view.View?=null
                check(waitUntil(30000){peerRow=find(activity.window.decorView,peer.getString("nickname"));peerRow!=null}){"conversation directory did not load"}
                val bounds=android.graphics.Rect();instrumentation.runOnMainSync{check(peerRow!!.getGlobalVisibleRect(bounds))}
                val now=android.os.SystemClock.uptimeMillis()
                instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,bounds.centerX().toFloat(),bounds.centerY().toFloat(),0))
                instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now+50,android.view.MotionEvent.ACTION_UP,bounds.centerX().toFloat(),bounds.centerY().toFloat(),0))
                check(waitUntil(30000){activity.findViewById<android.widget.EditText>(R.id.chat_message_input)?.isEnabled==true}){"direct chat did not open in the real UI"}
                report.put("realDirectoryTapOpened",true)
                val open=activity.javaClass.getDeclaredMethod("openExistingChat",Int::class.javaPrimitiveType).apply{isAccessible=true}
                instrumentation.runOnMainSync{open.invoke(activity,saved.getInt("id"))}
                val favoritesOpen=waitUntil(15000){activity.findViewById<android.widget.EditText>(R.id.chat_message_input)?.isEnabled==true}
                report.put("realFavoritesOpened",favoritesOpen)
                if(!favoritesOpen)failures.put(JSONObject().put("case","ui-favorites").put("valid",false))
                instrumentation.runOnMainSync{repeat(12){n->open.invoke(activity,if(n%2==0)saved.getInt("id") else cid)}}
                check(waitUntil(30000){activity.findViewById<android.widget.EditText>(R.id.chat_message_input)?.isEnabled==true}){"latest chat did not recover after rapid navigation"}
                val field=activity.javaClass.getDeclaredField("activeConversationId").apply{isAccessible=true};var active=0
                instrumentation.runOnMainSync{active=field.getInt(activity)};check(active==cid)
                report.put("rapidSwitchCount",12).put("latestConversationCorrect",true)
                val uiText="Android actual composer "+System.currentTimeMillis()
                instrumentation.runOnMainSync{activity.findViewById<android.widget.EditText>(R.id.chat_message_input).setText(uiText);activity.findViewById<android.view.View>(R.id.chat_message_send).performClick()}
                val sendDeadline=System.currentTimeMillis()+30000;var textReceived=false
                while(System.currentTimeMillis()<sendDeadline&&!textReceived){val history=b.historyPage(cid,0,50).items;textReceived=history.count{it.optJSONObject("body")?.optString("text")==uiText}==1;if(!textReceived)Thread.sleep(150)}
                check(textReceived){"actual composer was not received exactly once"};report.put("actualComposerExactlyOnce",true)
                if(strict){
                    val before=b.historyPage(cid,0,50).items.maxOfOrNull{it.optInt("id")}?:0
                    val uris=(0 until 2).map{n->
                        val file=File(context.cacheDir,"ui-media-$n.jpg");File(context.filesDir,"perf-upload.jpg").copyTo(file,overwrite=true)
                        androidx.core.content.FileProvider.getUriForFile(context,context.packageName+".fileprovider",file)
                    }
                    instrumentation.runOnMainSync{
                        val capture=activity.javaClass.getDeclaredMethod("captureSendTarget").apply{isAccessible=true}.invoke(activity)
                        check(capture!=null)
                        activity.javaClass.getDeclaredField("pendingMediaTarget").apply{isAccessible=true}.set(activity,capture)
                        val messages=activity.javaClass.getDeclaredField("currentMessages").apply{isAccessible=true}.get(activity)
                        activity.javaClass.getDeclaredMethod("uploadChatImages",List::class.java,android.widget.LinearLayout::class.java,Boolean::class.javaPrimitiveType).apply{isAccessible=true}.invoke(activity,uris,messages,false)
                    }
                    val photoDeadline=System.currentTimeMillis()+40000;var received=0
                    while(System.currentTimeMillis()<photoDeadline&&received<2){received=b.historyPage(cid,0,50).items.count{it.optInt("id")>before&&it.optString("type")=="image"};if(received<2)Thread.sleep(150)}
                    check(received==2){"actual activity media outbox lost or duplicated a selection"};report.put("actualActivityMediaOutbox",2)
                }
            }
            if(strict){
                val group=a.createGroup("媒体并发验收-"+System.currentTimeMillis(),JSONArray().put(peer.getInt("id")))
                val gid=group.getInt("id");check(checkOpen("group",gid).getBoolean("valid"))
                val worker=Executors.newFixedThreadPool(6);val run="android-concurrency-"+System.currentTimeMillis()
                try{
                    val texts=worker.invokeAll((0 until 12).map{n->Callable{a.sendText(cid,"Concurrent Android "+n,run+"-"+n)}},45,TimeUnit.SECONDS).map{it.get()}
                    check(texts.map{it.getInt("id")}.distinct().size==12)
                    val duplicates=worker.invokeAll((0 until 4).map{Callable{a.sendText(cid,"Duplicate Android request",run+"-duplicate")}},30,TimeUnit.SECONDS).map{it.get()}
                    check(duplicates.map{it.getInt("id")}.distinct().size==1)
                    val jpg=File(context.filesDir,"perf-upload.jpg")
                    val photos=worker.invokeAll((0 until 4).map{n->Callable{
                        val uploader=ApiClient(base).apply{token=a.token}
                        val uploaded=uploader.uploadMedia(jpg,"image","image/jpeg")
                        a.sendMediaMessage(cid,"image",uploaded,run+"-image-"+n)
                    }},90,TimeUnit.SECONDS).map{it.get()}
                    check(photos.map{it.getInt("id")}.distinct().size==4)
                    val received=b.historyPage(cid,0,50).items
                    val expected=(texts+duplicates.take(1)+photos).map{it.getInt("id")}
                    check(expected.all{id->received.count{it.getInt("id")==id}==1}){"concurrent media/text missing or duplicated at receiver"}
                    report.put("parallelText",12).put("sameRequestCalls",4).put("sameRequestMessages",1).put("parallelImages",4).put("receiverExactlyOnce",true)
                    var cancelled=false
                    try{a.uploadMedia(jpg,"image","image/jpeg",onCall={it.cancel()})}catch(e:ClientApiException){cancelled=e.errorCode=="upload_cancelled"}
                    check(cancelled){"upload cancellation did not stop admission"};report.put("uploadCancelPassed",true)
                }finally{worker.shutdownNow()}
            }
            if(strict)check(failures.length()==0){"conversation contract or concurrency failures: "+failures.toString()}
            val file=File(context.filesDir,"media-performance-probe.json");file.writeText(report.toString())
            output.putString("report",report.toString());output.putString("result",if(failures.length()==0)"passed" else "baseline-defects")
            instrumentation.finish(Activity.RESULT_OK,output)
        } catch(e:Throwable) {
            if(e is ClientApiException)report.put("errorCode",e.errorCode).put("status",e.status)
            output.putString("report",report.put("failures",failures).put("error",e.toString()).toString())
            output.putString("result","failed");instrumentation.finish(Activity.RESULT_CANCELED,output)
        }
    }
}
