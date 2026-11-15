package com.pulseim.android

import android.app.Instrumentation
import android.os.Bundle
import android.graphics.Bitmap
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Dedicated owned accounts only; exercises the installed client against deployed Go. */
internal object LiveReliabilityChecks {
    fun run(instrumentation: Instrumentation, arguments: Bundle) {
        val targetContext=instrumentation.targetContext
        val output=Bundle();val checks=JSONArray()
        try {
            GoV2Ids.context=targetContext.applicationContext;MobileDeviceIdentity.initialize(targetContext)
            val base="https://api.imapi.shop/api/v2"
            val prefix=requireNotNull(arguments.getString("prefix"))
            require(prefix.startsWith("rel")&&Regex("[a-z0-9]{12,32}").matches(prefix))
            val password=requireNotNull(arguments.getString("password"))
            fun login(suffix:String)=ApiClient(base).apply { token=login(prefix+suffix,password) }
            val a=login("a");val b=login("b");val c=login("c")
            val me=a.me();val peer=b.me();val third=c.me()
            check(me.getString("username")==prefix+"a"&&peer.getString("username")==prefix+"b")
            checks.put("real installed Android client login and own profile on deployed HTTPS Go")
            val direct=a.createDirectConversation(peer.getInt("id"));val cid=direct.getInt("id")
            val opened=a.openConversation(cid)
            check(opened.getInt("id")==cid&&opened.getString("type")=="direct")
            a.hideConversation(cid)
            val unhidden=a.openConversation(cid)
            check(unhidden.getInt("id")==cid&&unhidden.getString("type")=="direct"&&!unhidden.getBoolean("is_hidden"))
            checks.put("open normal and hidden conversation returns complete renderable data")
            val run="live-android-"+System.currentTimeMillis()
            val sent=a.sendText(cid,"Android real Go reliability check",run)
            val duplicate=a.sendText(cid,"Android real Go reliability check",run)
            check(sent.getInt("id")==duplicate.getInt("id"))
            val seen=b.history(cid)
            check((0 until seen.length()).any{seen.getJSONObject(it).getInt("id")==sent.getInt("id")})
            checks.put("text send, receiver history, same-request duplicate suppression")
            val response=b.sendText(cid,"Android receiver replied",run+"-reply")
            check(a.history(cid).let{rows->(0 until rows.length()).any{rows.getJSONObject(it).getInt("id")==response.getInt("id")}})
            checks.put("bidirectional delivery")
            val group=a.createGroup("修复验收组",JSONArray().put(peer.getInt("id")).put(third.getInt("id")))
            val gid=group.getInt("id")
            check(a.openConversation(gid).getString("type")=="group")
            val grouped=a.sendText(gid,"Android group reliability",run+"-group")
            check(b.history(gid).let{rows->(0 until rows.length()).any{rows.getJSONObject(it).getInt("id")==grouped.getInt("id")}})
            checks.put("create group, open and member message visibility")
            val image=File(targetContext.cacheDir,"live-reliability.png")
            val bitmap=Bitmap.createBitmap(96,64,Bitmap.Config.ARGB_8888).apply{eraseColor(android.graphics.Color.rgb(24,160,128))}
            image.outputStream().use{check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it))};bitmap.recycle()
            val upload=a.uploadMedia(image,"image","image/png",original=true)
            val picture=a.sendMediaMessage(cid,"image",upload,run+"-image")
            check(picture.getString("type")=="image")
            val content=b.history(cid).let{rows->(0 until rows.length()).map{rows.getJSONObject(it)}.first{it.getInt("id")==picture.getInt("id")}}
            check(content.getJSONObject("body").getString("url").startsWith("https://api.imapi.shop/api/v2/media-grants/"))
            checks.put("original image upload, ordered message commit and receiver authorization")
            val edited=a.editMessage(sent.getInt("id"),"Android corrected message",cid,sent.getString("version"))
            check(edited.getJSONObject("body").getString("text")=="Android corrected message")
            checks.put("edit message with version validation")
            if(arguments.getString("ui")=="true") {
                targetContext.getSharedPreferences("pulse_im_session",android.content.Context.MODE_PRIVATE).edit().putString("go_api_base_url",base).commit()
                val sessions=AccountSessions(targetContext,base)
                if(sessions.activeId()>0)sessions.invalidate(sessions.activeId())
                val activity=instrumentation.startActivitySync(android.content.Intent(targetContext,MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK))
                instrumentation.waitForIdleSync()
                var input:android.widget.EditText?=null
                val until=System.currentTimeMillis()+15000
                while(System.currentTimeMillis()<until&&input==null){instrumentation.runOnMainSync{input=activity.findViewById(R.id.auth_account)};if(input==null)Thread.sleep(150)}
                check(input!=null){"real login view did not open"}
                instrumentation.runOnMainSync{
                    activity.findViewById<android.widget.EditText>(R.id.auth_account).setText(prefix+"a")
                    activity.findViewById<android.widget.EditText>(R.id.auth_password).setText(password)
                    activity.findViewById<android.view.View>(R.id.auth_primary_action).performClick()
                }
                fun hasHome(view:android.view.View):Boolean = view is ChatHomeView || view is android.view.ViewGroup && (0 until view.childCount).any{hasHome(view.getChildAt(it))}
                var loggedIn=false
                val loginDeadline=System.currentTimeMillis()+30000
                while(System.currentTimeMillis()<loginDeadline&&!loggedIn){
                    Thread.sleep(150)
                    instrumentation.runOnMainSync{loggedIn=hasHome(activity.window.decorView)&&sessions.activeId()==me.getInt("id")&&sessions.token()!=null}
                }
                if(!loggedIn){var error="";instrumentation.runOnMainSync{error=activity.findViewById<android.widget.TextView>(R.id.auth_error)?.text?.toString().orEmpty()};error("real Android login UI failed: "+error)}
                checks.put("real installed MainActivity login form, app initialization and authenticated home")
                fun textView(view:android.view.View,text:String):android.widget.TextView? {
                    if(view is android.widget.TextView&&view.text.toString()==text)return view
                    if(view is android.view.ViewGroup)for(i in 0 until view.childCount){val found=textView(view.getChildAt(i),text);if(found!=null)return found}
                    return null
                }
                var rowView:android.view.View?=null
                val homeDeadline=System.currentTimeMillis()+30000
                while(System.currentTimeMillis()<homeDeadline&&rowView==null){
                    Thread.sleep(150);instrumentation.runOnMainSync{rowView=textView(activity.window.decorView,peer.getString("nickname"))}
                }
                check(rowView!=null){"authenticated conversation directory did not load"}
                val position=android.graphics.Rect()
                instrumentation.runOnMainSync{check(rowView!!.getGlobalVisibleRect(position))}
                val now=android.os.SystemClock.uptimeMillis()
                instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,position.centerX().toFloat(),position.centerY().toFloat(),0))
                instrumentation.sendPointerSync(android.view.MotionEvent.obtain(now,now+80,android.view.MotionEvent.ACTION_UP,position.centerX().toFloat(),position.centerY().toFloat(),0))
                var composer:android.widget.EditText?=null
                val chatDeadline=System.currentTimeMillis()+25000
                while(System.currentTimeMillis()<chatDeadline&&composer==null){Thread.sleep(100);instrumentation.runOnMainSync{composer=activity.findViewById<android.widget.EditText>(R.id.chat_message_input)?.takeIf{it.isEnabled}}}
                check(composer!=null){"real conversation did not open with enabled composer"}
                val uiTexts=listOf("Android界面发送一 "+run,"Android界面发送二 "+run)
                instrumentation.runOnMainSync{uiTexts.forEach{composer!!.setText(it);activity.findViewById<android.view.View>(R.id.chat_message_send).performClick()}}
                var delivered=false
                val deliveryDeadline=System.currentTimeMillis()+30000
                while(System.currentTimeMillis()<deliveryDeadline&&!delivered){Thread.sleep(200);val rows=b.history(cid);delivered=uiTexts.all{body->(0 until rows.length()).count{rows.getJSONObject(it).getJSONObject("body").optString("text")==body}==1}}
                check(delivered){"actual Android composer submissions were missing or duplicated"}
                checks.put("real conversation list selection, history rendering and two composer messages received exactly once")
                fun network(command:String){instrumentation.uiAutomation.executeShellCommand(command).use{android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes()}}
                val offlineTexts=listOf("Android断网排队一 "+run,"Android断网排队二 "+run)
                try {
                    network("svc wifi disable");network("svc data disable");Thread.sleep(1000)
                    instrumentation.runOnMainSync{offlineTexts.forEach{composer!!.setText(it);activity.findViewById<android.view.View>(R.id.chat_message_send).performClick()}}
                    Thread.sleep(1000)
                } finally {network("svc wifi enable");network("svc data enable")}
                var recovered=false
                val recoveryDeadline=System.currentTimeMillis()+45000
                while(System.currentTimeMillis()<recoveryDeadline&&!recovered){
                    Thread.sleep(500)
                    runCatching{val rows=b.history(cid);recovered=offlineTexts.all{body->(0 until rows.length()).count{rows.getJSONObject(it).getJSONObject("body").optString("text")==body}==1}}
                }
                check(recovered){"Android offline queue failed to resume automatically"}
                checks.put("real emulator network interruption, durable queued composer messages and automatic exactly-once recovery")
                Thread.sleep(500);instrumentation.waitForIdleSync()
                val screenshot=instrumentation.uiAutomation.takeScreenshot()
                File(targetContext.getExternalFilesDir(null),"reliability-home.png").outputStream().use{screenshot.compress(Bitmap.CompressFormat.PNG,100,it)};screenshot.recycle()
            }
            output.putString("result","passed");output.putString("checks",checks.toString())
            instrumentation.finish(android.app.Activity.RESULT_OK,output)
        } catch(error:Throwable) {
            runCatching {
                val shot=instrumentation.uiAutomation.takeScreenshot()
                File(targetContext.getExternalFilesDir(null),"reliability-failure.png").outputStream().use{shot.compress(Bitmap.CompressFormat.PNG,100,it)};shot.recycle()
            }
            output.putString("result","failed");output.putString("error",error.javaClass.simpleName+": "+error.message);output.putString("checks",checks.toString())
            instrumentation.finish(android.app.Activity.RESULT_CANCELED,output)
        }
    }
}
