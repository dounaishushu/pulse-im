package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.GridView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Exercise the real album Activity and its result/lifecycle against an isolated Go server. */
internal object PickerSendChecks {
    fun run(probe: Instrumentation, args: Bundle) {
        val result = Bundle()
        val report = JSONObject().put("sdk", Build.VERSION.SDK_INT)
        val inserted = mutableListOf<Uri>()
        var main: MainActivity? = null
        try {
            val context = probe.targetContext
            val base = requireNotNull(args.getString("base"))
            require(base.startsWith("http://10.0.2.2:"))
            val prefix = requireNotNull(args.getString("prefix")); require(prefix.startsWith("picker"))
            val password = requireNotNull(args.getString("password"))
            GoV2Ids.context = context.applicationContext; MobileDeviceIdentity.initialize(context)
            if(args.getString("baseline")!="true"){MediaIdentityChecks.run(context);report.put("stableMediaIdentityAndColdDiskReuse",true)}
            RouteManager.initialize(context,base,base.replaceFirst("http://","ws://")+"/realtime")
            val a = ApiClient(base).apply { token = login(prefix + "a", password) }
            val b = ApiClient(base).apply { token = login(prefix + "b", password) }
            val resetPrivacy=b.goPrivacy()
            b.updateGoPrivacy(JSONObject().put("expected_version",resetPrivacy.getString("version")).put("temporary_chat",JSONObject().put("visibility","everyone").put("allow",JSONArray()).put("deny",JSONArray())))
            val conversation = a.createDirectConversation(b.me().getInt("id"))
            val cid = conversation.getInt("id")
            context.getSharedPreferences("pulse_im_session", Context.MODE_PRIVATE).edit().putString("go_api_base_url",base).commit()
            val sessions = AccountSessions(context,base)
            if (sessions.activeId()>0) sessions.invalidate(sessions.activeId())
            val activity = probe.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            main = activity
            fun waitFor(timeout: Long = 20000, description: String, condition: () -> Boolean) {
                val until = System.currentTimeMillis() + timeout
                while (System.currentTimeMillis() < until) {
                    var ok = false; probe.runOnMainSync { ok = condition() }
                    if (ok) return
                    Thread.sleep(100)
                }
                error("Timed out: $description")
            }
            fun field(name:String):Any? = activity.javaClass.getDeclaredField(name).apply { isAccessible=true }.get(activity)
            fun tap(view: View) {
                val bounds=android.graphics.Rect()
                probe.runOnMainSync { check(view.isEnabled && view.getGlobalVisibleRect(bounds)) { "button not visible/enabled" } }
                val now=android.os.SystemClock.uptimeMillis()
                probe.sendPointerSync(android.view.MotionEvent.obtain(now,now,android.view.MotionEvent.ACTION_DOWN,bounds.centerX().toFloat(),bounds.centerY().toFloat(),0))
                probe.sendPointerSync(android.view.MotionEvent.obtain(now,now+50,android.view.MotionEvent.ACTION_UP,bounds.centerX().toFloat(),bounds.centerY().toFloat(),0))
                probe.waitForIdleSync()
            }
            waitFor(description="login page") { activity.findViewById<EditText>(R.id.auth_account)!=null }
            probe.runOnMainSync {
                activity.findViewById<EditText>(R.id.auth_account).setText(prefix+"a")
                activity.findViewById<EditText>(R.id.auth_password).setText(password)
                activity.findViewById<View>(R.id.auth_primary_action).performClick()
            }
            waitFor(description="authenticated home") { field("currentUserId") as Int > 0 && activity.findViewById<EditText>(R.id.auth_account)==null }
            a.token = requireNotNull(AccountSessions(context,base).token())
            probe.runOnMainSync { activity.javaClass.getDeclaredMethod("openExistingChat",Int::class.javaPrimitiveType).apply { isAccessible=true }.invoke(activity,cid) }
            waitFor(description="chat send permission") { activity.findViewById<View>(R.id.chat_attach)?.isEnabled==true && field("localOutboxesReady")==true && field("chatHistoryReady")==true && activity.hasWindowFocus() }
            probe.waitForIdleSync()
            report.put("version",context.packageManager.getPackageInfo(context.packageName,0).versionName)
            fun photo(name:String, format:Bitmap.CompressFormat):Uri {
                val values=ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME,name)
                    put(MediaStore.Images.Media.MIME_TYPE,if(format==Bitmap.CompressFormat.PNG) "image/png" else "image/jpeg")
                    if(Build.VERSION.SDK_INT>=29) { put(MediaStore.Images.Media.RELATIVE_PATH,"Pictures/PulsePickerChecks");put(MediaStore.Images.Media.IS_PENDING,1) }
                }
                val uri=requireNotNull(context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values));inserted.add(uri)
                val bitmap=Bitmap.createBitmap(640,480,Bitmap.Config.ARGB_8888)
                val canvas=Canvas(bitmap);canvas.drawColor(Color.rgb(30,130,105));val paint=Paint().apply {color=Color.WHITE;textSize=28f}
                canvas.drawText(name,25f,100f,paint)
                context.contentResolver.openOutputStream(uri)!!.use {check(bitmap.compress(format,90,it))};bitmap.recycle()
                if(Build.VERSION.SDK_INT>=29) context.contentResolver.update(uri,ContentValues().apply {put(MediaStore.Images.Media.IS_PENDING,0)},null,null)
                return uri
            }
            val photos=listOf(photo("picker-${System.nanoTime()}.jpg",Bitmap.CompressFormat.JPEG),photo("picker-${System.nanoTime()}.png",Bitmap.CompressFormat.PNG))
            val rows=JSONArray();report.put("cases",rows)
            fun waitChat() = waitFor(description="resumed and synchronized chat") {
                field("appForeground")==true && field("chatHistoryReady")==true && field("goRefreshRunning")==false &&
                    activity.findViewById<View>(R.id.chat_attach)?.isEnabled==true && activity.hasWindowFocus()
            }
            fun openAlbum(): PhotoAlbumPickerActivity {
                waitChat()
                val retainedMessages=field("currentMessages")
                val monitor=probe.addMonitor(PhotoAlbumPickerActivity::class.java.name,null,false)
                tap(activity.findViewById(R.id.chat_attach))
                waitFor(description="attachment menu") {activity.findViewById<View>(R.id.chat_attachment_photo)?.isShown==true}
                tap(activity.findViewById(R.id.chat_attachment_photo))
                val picker=monitor.waitForActivityWithTimeout(10000) as? PhotoAlbumPickerActivity ?: error("album Activity never opened")
                probe.removeMonitor(monitor)
                waitFor(description="parent paused") {field("appForeground")==false}
                probe.runOnMainSync {
                    check(field("currentMessages")===retainedMessages && field("chatHistoryReady")==true && field("goChatInvalidated")==false)
                    report.put("pickerRetainsAuthorizedHistory",true)
                }
                return picker
            }
            fun cellFor(picker: PhotoAlbumPickerActivity, uri: Uri): View {
                var cell: View?=null
                waitFor(description="MediaStore photo grid") {
                    val grid=picker.findViewById<GridView>(R.id.album_picker_grid)
                    for(i in 0 until grid.childCount) {
                        val candidate=grid.getChildAt(i)
                        val item=candidate.javaClass.getDeclaredField("photo").apply {isAccessible=true}.get(candidate) ?: continue
                        val itemUri=item.javaClass.getDeclaredField("uri").apply {isAccessible=true}.get(item) as Uri
                        if(android.content.ContentUris.parseId(itemUri)==android.content.ContentUris.parseId(uri)) {cell=candidate;break}
                    }
                    cell!=null
                }
                return requireNotNull(cell)
            }
            fun sendPreview(picker: PhotoAlbumPickerActivity, uri: Uri) {
                tap(cellFor(picker,uri))
                var send: View?=null
                waitFor(description="image preview send") {
                    val dialog=picker.javaClass.getDeclaredField("previewDialog").apply {isAccessible=true}.get(picker) as? android.app.Dialog
                    send=dialog?.findViewById(R.id.photo_preview_send);send?.isEnabled==true
                }
                tap(requireNotNull(send))
            }
            fun lastId()=b.historyPage(cid,0,50).items.maxOfOrNull {it.optInt("id")}?:0
            fun receivedAfter(before:Int)=b.historyPage(cid,0,50).items.filter {it.optInt("id")>before}
            fun awaitImages(before:Int,count:Int):List<JSONObject> {
                val until=System.currentTimeMillis()+30000
                var received=listOf<JSONObject>()
                while(System.currentTimeMillis()<until) {
                    received=receivedAfter(before).filter {it.optString("type")=="image"}
                    if(received.size>=count)return received
                    Thread.sleep(150)
                }
                error("Expected $count images, received ${received.size}")
            }
            for((index,uri) in photos.withIndex()) {
                val before=b.historyPage(cid,0,50).items.maxOfOrNull {it.optInt("id")}?:0
                val picker=openAlbum()
                val row=JSONObject().put("format",if(index==0)"jpeg" else "png")
                rows.put(row)
                probe.runOnMainSync {row.put("targetSurvivedPause",field("pendingMediaTarget")!=null)}
                val sentAt=android.os.SystemClock.elapsedRealtime()
                sendPreview(picker,uri)
                waitFor(description="returned to chat") {field("appForeground")==true && activity.findViewById<View>(R.id.chat_attach)?.isEnabled==true}
                row.put("returnToChatMs",android.os.SystemClock.elapsedRealtime()-sentAt)
                val deadline=System.currentTimeMillis()+if(args.getString("baseline")=="true")5000 else 30000
                var received=listOf<JSONObject>()
                while(System.currentTimeMillis()<deadline) {
                    received=b.historyPage(cid,0,50).items.filter {it.optInt("id")>before&&it.optString("type")=="image"}
                    if(received.isNotEmpty()) break
                    Thread.sleep(150)
                }
                row.put("received",received.size).put("exactlyOnce",received.size==1)
                if(received.size==1) {
                    val url=received.single().getJSONObject("body").getString("url")
                    val connection=java.net.URL(url).openConnection();connection.connectTimeout=10000;connection.readTimeout=10000
                    val image=connection.getInputStream().use {android.graphics.BitmapFactory.decodeStream(it)}
                    check(image!=null&&image.width>0&&image.height>0);image.recycle();row.put("receiverImageDecodes",true)
                }
                if(args.getString("baseline")=="true") break
            }
            val all=(0 until rows.length()).all {rows.getJSONObject(it).optBoolean("exactlyOnce")}
            if(args.getString("baseline")=="true") {check(!all) {"baseline did not reproduce"};result.putString("result","reproduced")}
            else {
                check(all) {"album result lost or duplicated"}
                var before=lastId()
                val cancelPicker=openAlbum();tap(cancelPicker.findViewById(R.id.album_picker_close));waitChat()
                check(field("pendingMediaTarget")==null&&receivedAfter(before).isEmpty())
                report.put("cancelSelectionClearsTarget",true)
                val multiple=openAlbum()
                for(uri in photos) {
                    val cell=cellFor(multiple,uri)
                    val tick=cell.javaClass.getDeclaredField("tickTarget").apply {isAccessible=true}.get(cell) as View
                    tap(tick)
                }
                tap(multiple.findViewById(R.id.album_picker_original))
                tap(multiple.findViewById(R.id.album_picker_confirm));waitChat()
                val batch=awaitImages(before,2);check(batch.size==2)
                val expected=photos.map {uri->context.contentResolver.openInputStream(uri)!!.use {java.security.MessageDigest.getInstance("SHA-256").digest(it.readBytes()).toList()}}.toSet()
                val actual=batch.map {message->java.net.URL(message.getJSONObject("body").getString("url")).openStream().use {java.security.MessageDigest.getInstance("SHA-256").digest(it.readBytes()).toList()}}.toSet()
                check(actual==expected);report.put("multiSelectOriginalExactlyOnce",2).put("originalBytesPreserved",true)
                before=lastId()
                val callback=activity.javaClass.getDeclaredMethod("onActivityResult",Int::class.javaPrimitiveType,Int::class.javaPrimitiveType,Intent::class.java).apply {isAccessible=true}
                probe.runOnMainSync {callback.invoke(activity,41,Activity.RESULT_OK,Intent().setData(photos[0]))}
                Thread.sleep(600);check(receivedAfter(before).isEmpty());report.put("lateDuplicateResultIgnored",true)
                before=lastId()
                val workers=field("photoUploadExecutor") as java.util.concurrent.ExecutorService
                val held=java.util.concurrent.CountDownLatch(2);val release=java.util.concurrent.CountDownLatch(1)
                repeat(2){workers.execute{held.countDown();release.await(20,java.util.concurrent.TimeUnit.SECONDS)}}
                check(held.await(5,java.util.concurrent.TimeUnit.SECONDS))
                try {
                    val delayed=openAlbum();sendPreview(delayed,photos[0])
                    waitFor(description="media claimed before background pause") {
                        (field("mediaOutbox") as DurableMediaOutbox).pending(cid).any{it.phase==DurableMediaOutbox.Phase.UPLOADING}
                    }
                    probe.runOnMainSync{probe.callActivityOnPause(activity)}
                    release.countDown()
                    waitFor(description="paused media remains queued") {
                        (field("mediaOutbox") as DurableMediaOutbox).pending(cid).any{it.phase==DurableMediaOutbox.Phase.QUEUED}
                    }
                    probe.runOnMainSync{probe.callActivityOnResume(activity)}
                    waitChat();check(awaitImages(before,1).size==1)
                    report.put("backgroundPauseAutomaticallyResumesExactlyOnce",true)
                }finally{release.countDown()}
                // Real permission changes while the album covers the chat must
                // be revalidated before the selected image enters the outbox.
                val denied=openAlbum()
                before=lastId()
                val privacy=b.goPrivacy()
                b.updateGoPrivacy(JSONObject().put("expected_version",privacy.getString("version")).put("temporary_chat",JSONObject().put("visibility","nobody").put("allow",JSONArray()).put("deny",JSONArray())))
                sendPreview(denied,photos[0])
                waitFor(description="permission denial applied") {field("appForeground")==true&&field("chatCanSend")==false&&field("chatSendDisabledReason")!="loading"}
                report.put("permissionRevokedTargetCleared",field("pendingMediaTarget")==null)
                check(field("pendingMediaTarget")==null) {"denied selection target was retained"};Thread.sleep(600);check(receivedAfter(before).isEmpty()) {"permission denial still sent media"}
                report.put("permissionRevokedDuringSelectionBlocked",true)
                val changed=b.goPrivacy();b.updateGoPrivacy(JSONObject().put("expected_version",changed.getString("version")).put("temporary_chat",privacy.getJSONObject("temporary_chat")))
                probe.runOnMainSync {activity.javaClass.getDeclaredMethod("refreshGoConversation").apply {isAccessible=true}.invoke(activity)}
                waitChat()
                // A denied camera permission or a missing external picker must
                // release the same pending send state as a cancelled album.
                fun capture() {
                    probe.runOnMainSync {
                        val target=activity.javaClass.getDeclaredMethod("captureSendTarget").apply {isAccessible=true}.invoke(activity)
                        activity.javaClass.getDeclaredField("pendingMediaTarget").apply {isAccessible=true}.set(activity,target)
                        activity.javaClass.getDeclaredField("pendingMediaBase").apply {isAccessible=true}.set(activity,base)
                    }
                }
                capture()
                probe.runOnMainSync {activity.onRequestPermissionsResult(1944,arrayOf(android.Manifest.permission.CAMERA),intArrayOf(android.content.pm.PackageManager.PERMISSION_DENIED))}
                check(field("pendingMediaTarget")==null);report.put("cameraPermissionDeniedClearsTarget",true)
                capture()
                probe.runOnMainSync {activity.javaClass.getDeclaredMethod("launchMediaPicker",Intent::class.java,Int::class.javaPrimitiveType).apply {isAccessible=true}.invoke(activity,Intent("com.pulseim.fixture.NO_PICKER_HANDLER"),41)}
                check(field("pendingMediaTarget")==null);report.put("missingPickerClearsTarget",true)
                PhotoOriginalChecks.run(context,a,b,cid)
                report.put("originalAndDurableOutboxRegression",true)
                probe.uiAutomation.takeScreenshot()?.let {bitmap->File(context.filesDir,"picker-fixed-api${Build.VERSION.SDK_INT}.png").outputStream().use {bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}
                // Profile images use a different result handler. Exercise its
                // normal UI and reject a callback after the stored account changes.
                probe.runOnMainSync {activity.javaClass.getDeclaredMethod("showMyPage",String::class.java).apply {isAccessible=true}.invoke(activity,"profile")}
                waitFor(description="profile avatar") {activity.findViewById<View>(R.id.profile_avatar)?.isShown==true}
                fun avatarPicker():PhotoAlbumPickerActivity {
                    var avatar:View?=null;var stableAt=0L
                    waitFor(description="settled profile avatar") {
                        val current=activity.findViewById<View>(R.id.profile_avatar)
                        if(current!==avatar){avatar=current;stableAt=android.os.SystemClock.elapsedRealtime()}
                        current?.isShown==true&&current.isEnabled&&activity.hasWindowFocus()&&android.os.SystemClock.elapsedRealtime()-stableAt>300
                    }
                    val monitor=probe.addMonitor(PhotoAlbumPickerActivity::class.java.name,null,false)
                    tap(activity.findViewById(R.id.profile_avatar))
                    val picker=monitor.waitForActivityWithTimeout(10000) as? PhotoAlbumPickerActivity ?: error("avatar album never opened")
                    probe.removeMonitor(monitor);tap(picker.findViewById(R.id.album_picker_photos))
                    return picker
                }
                fun confirmAvatar(picker:PhotoAlbumPickerActivity) {tap(cellFor(picker,photos[0]));tap(picker.findViewById(R.id.album_picker_confirm))}
                val oldAvatar=a.me().optString("avatar_url")
                confirmAvatar(avatarPicker())
                val avatarUntil=System.currentTimeMillis()+30000
                var newAvatar=""
                while(System.currentTimeMillis()<avatarUntil) {
                    newAvatar=a.me().optString("avatar_url")
                    if(newAvatar.isNotBlank()&&newAvatar!=oldAvatar)break
                    Thread.sleep(150)
                }
                check(newAvatar.isNotBlank()&&newAvatar!=oldAvatar) {"profile avatar did not update"}
                val avatarBitmap=java.net.URL(newAvatar).openStream().use {android.graphics.BitmapFactory.decodeStream(it)}
                check(avatarBitmap!=null);avatarBitmap.recycle();report.put("realProfileAvatarRoundtrip",true)
                waitFor(description="updated profile") {activity.findViewById<View>(R.id.profile_avatar)?.isShown==true&&field("appForeground")==true}
                val staleAvatarPicker=avatarPicker()
                val stored=AccountSessions(context,base);val originalAccount=a.me();val originalToken=requireNotNull(a.token)
                try {
                    stored.save(b.me(),requireNotNull(b.token))
                    confirmAvatar(staleAvatarPicker)
                    waitFor(description="stale avatar returned") {field("appForeground")==true}
                    Thread.sleep(600)
                    check(a.me().optString("avatar_url")==newAvatar) {"old avatar selection mutated the previous account"}
                    val feature=field("myFeature")!!
                    check(feature.javaClass.getDeclaredField("avatarTarget").apply {isAccessible=true}.get(feature)==null)
                    report.put("avatarAccountChangeRejected",true)
                } finally {stored.save(originalAccount,originalToken)}
                result.putString("result","passed")
            }
        } catch(error:Throwable) {
            result.putString("result","failed");report.put("error",error.toString()).put("errorLocation",error.stackTrace.take(5).joinToString("\n"))
            runCatching {probe.uiAutomation.takeScreenshot()?.let {bitmap->File(probe.targetContext.filesDir,"picker-failure.png").outputStream().use {bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}}
        }
        finally {
            inserted.forEach {runCatching {probe.targetContext.contentResolver.delete(it,null,null)}}
            main?.let {probe.runOnMainSync {it.finish()}}
        }
        File(probe.targetContext.filesDir,"picker-send-report.json").writeText(report.toString())
        result.putString("report",report.toString());probe.finish(if(result.getString("result")=="failed")Activity.RESULT_CANCELED else Activity.RESULT_OK,result)
    }
}
