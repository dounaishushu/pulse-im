package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** No real server: hold preparation/upload workers and exercise actual picker/outbox UI. */
class OutgoingPhotoProbe:Instrumentation() {
    override fun onCreate(arguments:Bundle?){super.onCreate(arguments);start()}
    override fun onStart(){
        var activity:MainActivity?=null
        val gates=mutableListOf<CountDownLatch>();val checks=JSONArray()
        try {
            check(targetContext.packageName.endsWith(".scrollprobe"))
            GoV2Ids.context=targetContext.applicationContext
            activity=startActivitySync(Intent().setClassName(targetContext.packageName,MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val host=activity
            fun field(name:String)=MainActivity::class.java.getDeclaredField(name).apply{isAccessible=true}
            fun get(name:String)=field(name).get(host)
            fun set(name:String,value:Any?)=field(name).set(host,value)
            fun ui(action:()->Unit)=runOnMainSync(action)
            fun invoke(name:String,vararg args:Any?){val method=MainActivity::class.java.declaredMethods.single{it.name==name&&it.parameterCount==args.size};method.isAccessible=true;method.invoke(host,*args)}
            fun until(condition:()->Boolean){val end=SystemClock.uptimeMillis()+5000;while(SystemClock.uptimeMillis()<end){waitForIdleSync();var ready=false;ui{ready=condition()};if(ready)return;SystemClock.sleep(40)};error("Outgoing photo UI did not settle")}
            val base=get("apiBaseUrl") as String;check(base.startsWith("http://127.0.0.1:9/"))
            val token="local-photo-probe";val user=GoV2Ids.local(base,"user",UUID.randomUUID().toString())
            val directory=File(host.cacheDir,"outgoing-probe-${UUID.randomUUID()}").apply{mkdirs()}
            val files=listOf(Color.RED,Color.GREEN).mapIndexed{index,color->
                File(directory,"source-$index.png").also{file->val bitmap=Bitmap.createBitmap(640,360,Bitmap.Config.ARGB_8888);bitmap.eraseColor(color);file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}
            }
            val uris=files.map{FileProvider.getUriForFile(host,host.packageName+".fileprovider",it)}
            val uploadGate=CountDownLatch(1);gates+=uploadGate
            repeat(2){(get("photoUploadExecutor") as ExecutorService).execute{uploadGate.await(30,TimeUnit.SECONDS)}}
            for(kind in listOf("direct","group")) {
                val cid=GoV2Ids.local(base,"conversation",UUID.randomUUID().toString())
                val target=SendTarget(cid,user,token)
                val key=SecretKeySpec(ByteArray(32).apply{java.security.SecureRandom().nextBytes(this)},"AES")
                val store=object:OutboxPersistence{var value:ByteArray?=null;override fun read()=value?.clone();override fun write(bytes:ByteArray){value=bytes.clone()}}
                val attachments=OutboxAttachments(File(directory,"$kind-enc"),File(directory,"$kind-open"),object:OutboxAttachments.Ciphers{
                    override fun encrypt(id:String)=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.ENCRYPT_MODE,key);updateAAD(id.toByteArray())}
                    override fun decrypt(id:String,iv:ByteArray)=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.DECRYPT_MODE,key,GCMParameterSpec(128,iv));updateAAD(id.toByteArray())}
                })
                val queue=DurableMediaOutbox(store,attachments,token,user,base)
                lateinit var messages:LinearLayout
                ui {
                    (get("api") as ApiClient).token=token;set("currentUserId",user);set("activeConversationId",cid);set("activeConversationType",kind)
                    set("mediaOutbox",queue);set("localOutboxOwner",LocalDirectorySync.Account(base,user,token))
                    set("chatCanSend",true);set("chatHistoryReady",true);set("goChatInvalidated",false);set("goChatRevalidate",true);set("goRefreshRunning",false)
                    set("goMembershipVersion","1");GoV2Ids.membership(base,user,cid,"1",token)
                    messages=LinearLayout(host).apply{orientation=LinearLayout.VERTICAL}
                    val scroll=ScrollView(host).apply{addView(messages)}
                    val root=LinearLayout(host).apply{orientation=LinearLayout.VERTICAL;addView(scroll,LinearLayout.LayoutParams(-1,0,1f));addView(EditText(host).apply{id=R.id.chat_message_input;setText("保留草稿")})}
                    host.setContentView(root);set("currentMessages",messages);set("pendingMediaTarget",target);set("pendingMediaBase",base)
                    invoke("acceptPickedMedia",uris,"image",false)
                }
                val ids=listOf(target.requestId,target.requestId+"-photo-1")
                until{ids.all{(messages.findViewWithTag<PendingPhotoPreview>("pending-media:$it")?.image?.drawable as? BitmapDrawable)!=null}}
                val retained=mutableListOf<PendingPhotoPreview>()
                ui{
                    check(queue.pending(cid).isEmpty()){"Upload started before metadata revalidation"}
                    ids.forEachIndexed{index,id->val row=messages.findViewWithTag<PendingPhotoPreview>("pending-media:$id");retained+=row;val bitmap=(row.image.drawable as BitmapDrawable).bitmap;check(bitmap.getPixel(bitmap.width/2,bitmap.height/2)==listOf(Color.RED,Color.GREEN)[index])}
                }
                checks.put("$kind: selected photos appear before network permission refresh or upload")
                checks.put("$kind: local thumbnails preserve multi-photo selection order")
                SystemClock.sleep(150);waitForIdleSync()
                val centers=mutableListOf<Pair<Int,Int>>()
                ui{retained.forEach{row->val position=IntArray(2);row.image.getLocationOnScreen(position);centers+=Pair(position[0]+row.image.width/2,position[1]+row.image.height/2)}}
                uiAutomation.takeScreenshot()?.let{bitmap->
                    centers.forEachIndexed{index,center->check(bitmap.getPixel(center.first,center.second)==listOf(Color.RED,Color.GREEN)[index]){"Selected image was not painted before upload"}}
                    File(targetContext.filesDir,"outgoing-$kind-pending.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()
                }?:error("Cannot capture outgoing image preview")
                checks.put("$kind: both selected images are painted on screen before upload")
                val stageGate=CountDownLatch(1);gates+=stageGate
                (get("outboxStageExecutor") as ExecutorService).execute{stageGate.await(10,TimeUnit.SECONDS)}
                ui{set("goChatRevalidate",false);invoke("drainPickedMedia");check(queue.pending(cid).isEmpty());check(retained.all{it.parent===messages})}
                checks.put("$kind: slow compression/preparation keeps photos visible")
                stageGate.countDown();until{queue.pending(cid).size==2&&queue.pending(cid).first().phase==DurableMediaOutbox.Phase.UPLOADING}
                ui{check(ids.map{messages.findViewWithTag<PendingPhotoPreview>("pending-media:$it")}==retained);check(queue.pending(cid).map{it.requestId}==ids)}
                checks.put("$kind: upload phase updates retain thumbnail views and request IDs")
                ui{
                    (get("pendingPhotoThumbnails") as PendingPhotoThumbnails).clear()
                    (get("localPhotoSources") as MutableMap<*,*>).clear()
                    val scroll=messages.parent as ScrollView;scroll.removeView(messages)
                    messages=LinearLayout(host).apply{orientation=LinearLayout.VERTICAL};scroll.addView(messages);set("currentMessages",messages)
                    invoke("renderPendingMediaMessages",messages)
                }
                until{ids.all{messages.findViewWithTag<PendingPhotoPreview>("pending-media:$it")?.image?.drawable!=null}}
                ui{retained.clear();ids.forEach{retained+=messages.findViewWithTag<PendingPhotoPreview>("pending-media:$it")}}
                check(File(directory,"$kind-open").listFiles().orEmpty().isEmpty())
                checks.put("$kind: restored queued and uploading images preview from encrypted local files")
                val second=queue.pending(cid).last();ui{queue.fail(second,"injected upload failure");invoke("renderPendingMediaMessages",messages)}
                fun labels(view:View):List<TextView> = if(view is TextView)listOf(view) else if(view is ViewGroup)(0 until view.childCount).flatMap{labels(view.getChildAt(it))} else emptyList()
                ui{val row=retained.last();check(row.image.drawable!=null);labels(row).first{it.text.contains("点击重试")}.performClick()}
                until{second.phase==DurableMediaOutbox.Phase.QUEUED&&second.requestId==ids.last()}
                checks.put("$kind: failed sends retain previews and retry the same request")
                ui{queue.fail(second,"discard probe");invoke("renderPendingMediaMessages",messages);labels(retained.last()).first{it.text=="移除"}.performClick()}
                until{messages.findViewWithTag<View>("pending-media:${second.requestId}")==null}
                check(runCatching{queue.openPreview(second)}.isFailure)
                checks.put("$kind: discarding a failed image removes its preview")
                ui{set("currentUserId",user+1);invoke("renderPendingMediaMessages",messages);check((0 until messages.childCount).none{(messages.getChildAt(it).tag as? String)?.startsWith("pending-media:")==true});set("currentUserId",user);invoke("renderPendingMediaMessages",messages)}
                until{messages.findViewWithTag<PendingPhotoPreview>("pending-media:${target.requestId}")?.image?.drawable!=null}
                checks.put("$kind: outgoing previews do not cross account scope")
                val media=UUID.randomUUID().toString();val grant=JSONObject().put("content_path","/api/v2/media-grants/"+"a".repeat(64)+"/content").put("expires_in",120)
                val sessionHash=MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).joinToString(""){"%02x".format(it.toInt() and 255)}
                val upload=JSONObject().put("id",media).put("url","pulse-media:$media").put("_go_access",grant).put("_go_access_deadline",System.currentTimeMillis()+120000).put("_go_access_base",base).put("_go_access_session",sessionHash)
                val displayURL=ApiClient(base).apply{this.token=token}.uploadedMediaContentURL(upload)
                check(displayURL.startsWith("http://127.0.0.1:9/api/v2/media-grants/"))
                val message=JSONObject().put("id",100).put("conversation_id",cid).put("sender_id",user).put("type","image").put("_go_version","1".padStart(20,'0')).put("status","sent").put("created_at","2026-11-17T00:00:00Z")
                    .put("body",JSONObject().put("url",displayURL).put("width",640).put("height",360).put("request_id",target.requestId).put("_go_media_id",media))
                ui{invoke("addMessage",messages,message,"ack");check(messages.findViewWithTag<View>("pending-media:${target.requestId}")==null);check(messages.findViewWithTag<View>(100)!=null);check(ChatImageCache.cached(base+"|"+token,displayURL)!=null)}
                checks.put("$kind: confirmed image reuses the local thumbnail without a blank frame")
                until{queue.pending(cid).isEmpty()}
                checks.put("$kind: confirmation removes the pending entry without duplicating it")
                ui{val confirmed=messages.findViewWithTag<View>(100);invoke("addMessage",messages,message,"ack");check(messages.findViewWithTag<View>(100)===confirmed);check((0 until messages.childCount).count{messages.getChildAt(it).tag==100}==1)}
                checks.put("$kind: duplicate confirmation does not duplicate or replace the image")
                ChatImageCache.seedUploaded(host,base+"|"+token,displayURL,files.first()){true}
                check(ChatImageCache.load(host,base+"|"+token,displayURL,2560){true}.width==640)
                checks.put("$kind: uploaded Go media resolves to an HTTP cache key and loads without downloading")
            }
            val report=JSONObject().put("passed",checks.length()).put("checks",checks)
            File(targetContext.filesDir,"outgoing-photo-results.json").writeText(report.toString(2))
            finish(Activity.RESULT_OK,Bundle().apply{putString("checks",report.toString())})
        }catch(error:Throwable){finish(Activity.RESULT_CANCELED,Bundle().apply{putString("error",error.stackTraceToString())})}
        finally{gates.forEach{it.countDown()};activity?.let{runOnMainSync{it.finish()}}}
    }
}
