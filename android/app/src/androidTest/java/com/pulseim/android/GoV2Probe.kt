package com.pulseim.android

import android.app.Instrumentation
import android.app.Activity
import android.os.Bundle
import org.json.JSONObject
import org.json.JSONArray
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.graphics.Bitmap
import java.io.File
import java.net.URL

/** Runs the shipping ApiClient/SocketClient on an isolated emulator against a
 * disposable Go/PostgreSQL/Redis stack. No mocks and no production credentials. */
class GoV2Probe:Instrumentation(){
 private var args=Bundle()
 override fun onCreate(arguments:Bundle?){super.onCreate(arguments);args=arguments?:Bundle();start()}
 override fun onStart(){
  val result=Bundle();val checks=JSONArray()
  var socket:SocketClient?=null
  try{
   GoV2Ids.context=targetContext.applicationContext;MobileDeviceIdentity.initialize(targetContext)
   val base=args.getString("base")?:"http://10.0.2.2:18080/api/v2"
   require(base.startsWith("http://10.0.2.2:")||base.startsWith("http://127.0.0.1:")){"isolated server required"}
   val prefix=requireNotNull(args.getString("prefix"));val password=requireNotNull(args.getString("password"))
   var sessionVersion=1L
   var lateGrant=false
   val avatar="22222222-2222-4222-8222-222222222222"
   val adapter=GoV2Api(base,{"fixture-$sessionVersion"},{sessionVersion}){path,_,_,expected->
       check(expected==sessionVersion)
       if(path=="/me/profile")JSONObject().put("id","11111111-1111-4111-8111-111111111111").put("account","fixture").put("avatar_id",avatar)
       else{if(lateGrant)sessionVersion++;JSONObject().put("content_path","/api/v2/media-grants/"+"a".repeat(64)+"/content").put("expires_in",120)}
   }
   adapter.request("/auth/me","GET",null)
   sessionVersion++;lateGrant=true
   try{adapter.request("/auth/me","GET",null);error("late previous-account avatar accepted")}catch(e:ClientApiException){check(e.errorCode=="stale_session")}
   checks.put("media grant cache is session scoped and rejects a late account response")
   var avatarDenial=403
   val unavailableAvatar=GoV2Api(base,{"fixture"},{1L}){path,_,_,_->
       if(path.startsWith("/media/"))throw ClientApiException(avatarDenial,"forbidden","fixture denial")
       JSONObject().put("id","11111111-1111-4111-8111-111111111111").put("account","fixture").put("avatar_id",avatar)
   }
   val noAvatar=unavailableAvatar.request("/contacts/search?q=fixture","GET",null).getJSONObject("data").getJSONArray("items")
   check(noAvatar.length()==1&&noAvatar.getJSONObject(0).getString("avatar_url").isEmpty())
   avatarDenial=401
   try{unavailableAvatar.request("/contacts/search?q=fixture","GET",null);error("expired login hidden by avatar fallback")}catch(e:ClientApiException){check(e.status==401)}
   checks.put("inaccessible optional avatars preserve the directory while expired sessions still fail")
   val originalURL="http://127.0.0.1/api/v2/media-grants/"+"a".repeat(64)+"/content"
   check(ChatImagePreview.url(originalURL)==originalURL.removeSuffix("content")+"preview")
   check(ChatImagePreview.url("https://images.example.invalid/photo.jpg")=="https://images.example.invalid/photo.jpg")
   checks.put("Go thumbnail mapping preserves original and unrelated links")
   fun login(suffix:String)=ApiClient(base).apply{token=login(prefix+suffix,password)}
   val a=login("a");val b=login("b");val c=login("c")
   val alice=a.me();val bob=b.me();val carol=c.me()
   check(a.contacts().length()==0)
   val direct=a.createDirectConversation(carol.getInt("id"));val cid=direct.getInt("id")
   check(direct.getBoolean("temporary"));check(a.contacts().length()==0);checks.put("temporary chat does not create friendship")
   val sent=a.sendText(cid,"Android to Go message","android-probe-one")
   val duplicate=a.sendText(cid,"Android to Go message","android-probe-one")
   check(sent.getInt("id")==duplicate.getInt("id"));check(c.history(cid).length()==1);checks.put("text idempotency and history")
   check(sent.getString("sender_name")==alice.getString("nickname"));check(c.history(cid).getJSONObject(0).getString("sender_name")==alice.getString("nickname"))
   val edited=a.editMessage(sent.getInt("id"),"edited Android message",cid,sent.getString("version"))
   check(edited.getJSONObject("body").getString("text")=="edited Android message")
   java.time.OffsetDateTime.parse(edited.getString("edited_at")).toInstant()
   check(java.time.OffsetDateTime.parse(edited.getString("created_at")).toInstant()==java.time.OffsetDateTime.parse(edited.getString("_wire_created_at")).toInstant())
   GoV2Ids.message(base,cid,JSONObject().put("seq",sent.getString("seq")).put("id",sent.getString("wire_id")).put("version",sent.getString("version")))
   check(GoV2Ids.message(base,cid,sent.getInt("id")).second==edited.getString("version"))
   check(c.history(cid).getJSONObject(0).getJSONObject("body").getString("text")=="edited Android message")
   try{a.editMessage(sent.getInt("id"),"stale overwrite",cid,sent.getString("version"));error("stale editor bypassed CAS")}catch(e:ClientApiException){check(e.status==409)}
   check(c.history(cid).getJSONObject(0).getJSONObject("body").getString("text")=="edited Android message");checks.put("edit through UUID and version including stale editor rejection")
   val reply=c.sendText(cid,"ordinary author","android-own-edit")
   try{a.editMessage(reply.getInt("id"),"unauthorized rewrite",cid,reply.getString("version"));error("staff edited other sender")}catch(e:ClientApiException){check(e.status==403)}
   val ownEdit=c.editMessage(reply.getInt("id"),"author correction",cid,reply.getString("version"));check(ownEdit.getString("version")=="2")
   checks.put("only sender may edit, including internal staff restriction")
   val located=c.locateMessage(cid,reply.getInt("id")).getJSONArray("items")
   check((0 until located.length()).map{located.getJSONObject(it).getInt("id")}==listOf(sent.getInt("id"),reply.getInt("id")))
   c.hideConversation(cid);check((0 until c.conversations().length()).none{c.conversations().getJSONObject(it).getInt("id")==cid})
   a.sendText(cid,"reopen hidden chat","android-hidden-reopened")
   val restored=c.conversations();check((0 until restored.length()).any{restored.getJSONObject(it).getInt("id")==cid})
   checks.put("unique ordered message location and hidden chat restored by a new message")
   var privacy=c.goPrivacy()
   c.updateGoPrivacy(JSONObject().put("expected_version",privacy.getString("version")).put("temporary_chat",JSONObject().put("visibility","nobody").put("allow",JSONArray()).put("deny",JSONArray())))
   try{a.sendText(cid,"denied","android-probe-denied");error("privacy bypass")}catch(e:ClientApiException){check(e.status==403)}
   privacy=c.goPrivacy();c.updateGoPrivacy(JSONObject().put("expected_version",privacy.getString("version")).put("temporary_chat",JSONObject().put("visibility","everyone").put("allow",JSONArray()).put("deny",JSONArray())))
   c.blockUser(alice.getInt("id"));try{a.sendText(cid,"blocked","android-probe-blocked");error("block bypass")}catch(e:ClientApiException){check(e.status==403)}
   val blocked=c.blocks();check(blocked.length()==1);check(blocked.getJSONObject(0).getInt("blocked_id")==alice.getInt("id"))
   c.unblock(blocked.getJSONObject(0).getInt("blocked_id"))
   val candidates=c.blockCandidates("dialogs","",1).getJSONArray("items");check((0 until candidates.length()).any{candidates.getJSONObject(it).getInt("user_id")==alice.getInt("id")})
   checks.put("current privacy, block precedence and blacklist UI contract")
   val group=a.createGroup("Android 历史权限联调",allowMemberAddFriend=false);val gid=group.getInt("id")
   check(!a.groupProfile(gid).getBoolean("allow_member_add_friend"))
   val old=a.sendText(gid,"邀请之前的消息","android-group-old")
   a.addConversationMember(gid,bob.getInt("id"),false);a.addConversationMember(gid,carol.getInt("id"),true)
   b.joinGroup(group.getString("invite_code"))
   check(b.history(gid).length()==0);check(c.history(gid).length()==1);checks.put("invitation history checked and unchecked")
   val oldVersion=b.conversationInfo(gid).getString("membership_version")
   val oldSnapshot=b.syncMessages(gid,1,0,null)
   a.removeConversationMember(gid,bob.getInt("id"));a.addConversationMember(gid,bob.getInt("id"),true)
   try{b.syncMessages(gid,1,0,oldSnapshot.getInt("snapshot_max_id"),oldSnapshot.getString("membership_version"));error("old membership snapshot accepted")}catch(e:ClientApiException){check(e.errorCode=="membership_changed")}
   val currentVersion=b.conversationInfo(gid).getString("membership_version");check(currentVersion!=oldVersion)
   b.syncMessages(gid,1,0,null)
   try{b.syncMessages(gid,1,0,oldSnapshot.getInt("snapshot_max_id"),oldSnapshot.getString("membership_version"));error("concurrent snapshot replaced pinned version")}catch(e:ClientApiException){check(e.errorCode=="membership_changed")}
   try{GoV2Ids.membership(base,bob.getInt("id"),gid,oldVersion,b.token);error("stale membership restored")}catch(e:ClientApiException){check(e.errorCode=="membership_changed")}
   GoV2Ids.requireMembership(base,bob.getInt("id"),gid,currentVersion)
   val page=b.historyPage(gid);check(page.membershipVersion==currentVersion);check(page.items.size==1);checks.put("rejoin and stale/concurrent membership rejection")
   val clearBoundary=c.conversationInfo(gid).getInt("message_seq")
   val cleared=c.clearHistory(gid);check(cleared.getInt("cleared_before_message_id")==clearBoundary)
   check(c.historyPage(gid).clearedBefore==clearBoundary)
   val newer=a.sendText(gid,"清空之后的消息","android-group-new")
   check(c.history(gid).length()==1)
   c.deleteMessages(gid,listOf(newer.getInt("id")));check(c.history(gid).length()==0);checks.put("personal clear and deletion")
   val req=b.sendFriendRequest(alice.getInt("id"),"Android friend request")
   a.handleFriendRequest(req.getInt("request_id"),"accept");check(a.contacts().length()==1);checks.put("friend request and acceptance")
   val updatedProfile=a.updateProfile(JSONObject().put("signature","Android profile fixture"))
   check(updatedProfile.getString("signature")=="Android profile fixture")
   b.updateContactRemark(alice.getInt("id"),"Kept remark","Fixture group")
   val friendProfile=b.contactProfile(alice.getInt("id"))
   val friendList=b.contacts().getJSONObject(0)
   check(friendList.getString("remark")=="Kept remark"&&friendList.getString("group_name")=="Fixture group")
   checks.put("contact list preserves viewer remark and group")
   check(friendProfile.getString("signature")=="Android profile fixture")
   check(friendProfile.getString("remark")=="Kept remark")
   check(friendProfile.getString("group_name")=="Fixture group")
   check(PublicUserId.value(friendProfile.optString("public_id"))!=null)
   checks.put("full contact profile, remarks, grouping and signature mapping")
   check(a.updateGroupSettings(gid,isPinned=true).getBoolean("is_pinned"))
   check(!a.updateGroupSettings(gid,isPinned=false,notificationsMuted=true).getBoolean("is_pinned"))
   checks.put("group pin and notification preferences")
   val ready=CountDownLatch(1);val changed=CountDownLatch(1)
   val socketBase=args.getString("socket_base")?:base
   require(socketBase.startsWith("http://10.0.2.2:")||socketBase.startsWith("http://127.0.0.1:"))
   socket=SocketClient(socketBase.replace("http://","ws://")+"/realtime",requireNotNull(a.token),{_,packet->if(packet.optString("type")=="go.changed"&&packet.optInt("conversation_id")==gid)changed.countDown()},{_,connected->if(connected)ready.countDown()},apiIdentity=base)
   socket.connect();check(ready.await(8,TimeUnit.SECONDS)){"ready timeout"};b.sendText(gid,"实时通知验证","android-websocket");check(changed.await(8,TimeUnit.SECONDS)){"hint or logical conversation mapping timeout"};checks.put("single-use WebSocket ticket and alias-independent conversation identity")
   socket.close();socket=null
   a.muteConversationMember(gid,bob.getInt("id"),10)
   check(!b.groupProfile(gid).getBoolean("can_send"))
   a.muteConversationMember(gid,bob.getInt("id"),0)
   val mention=a.sendText(gid,"@${bob.getString("nickname")} reminder","android-mention-summary",mentionUserIds=intArrayOf(bob.getInt("id")))
   val reminder=b.conversationInfo(gid)
   check(reminder.getInt("unread_mention_count")==1&&reminder.getInt("last_mention_message_id")==mention.getInt("id"))
   b.readConversation(gid,mention.getInt("id"));check(b.conversationInfo(gid).getInt("unread_mention_count")==0)
   checks.put("timed mute and unread mentions survive a full conversation refresh")
   a.muteConversationMember(gid,bob.getInt("id"),-1)
   check(!b.groupProfile(gid).getBoolean("can_send"));check(b.groupProfile(gid).getString("send_disabled_reason")=="member_muted")
   try{b.sendText(gid,"must not send","android-probe-muted");error("mute bypass")}catch(e:ClientApiException){check(e.status==403)}
   a.muteConversationMember(gid,bob.getInt("id"),0);checks.put("permanent mute and unmute")
   val picture=File(targetContext.cacheDir,"go-contract-image.png")
   val bitmap=Bitmap.createBitmap(96,72,Bitmap.Config.ARGB_8888)
   try{bitmap.eraseColor(android.graphics.Color.BLUE);picture.outputStream().use{check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it))}}finally{bitmap.recycle()}
   try{
       val upload=a.uploadMedia(picture,"image","image/png")
       val image=a.sendMediaMessage(gid,"image",upload,"android-media-image")
       val received=b.history(gid).let{rows->(0 until rows.length()).map{rows.getJSONObject(it)}.first{it.getInt("id")==image.getInt("id")}}
       val content=received.getJSONObject("body").getString("url")
       check(content.endsWith("/content"))
       URL(ChatImagePreview.url(content)).openStream().use{check(it.read()>=0)}
       check(b.sharedMedia(gid,1).getJSONArray("items").length()>0)
       a.updateProfile(JSONObject().put("avatar_url",upload.getString("url")))
       check(b.contactProfile(alice.getInt("id")).getString("avatar_url").isNotEmpty())
   }finally{picture.delete()}
   checks.put("image upload, authorized preview, shared media and contact avatar")
   PhotoOriginalChecks.run(targetContext,a,b,gid)
   checks.put("original photo exact-byte upload/download, compression choice, durable retry and v1 queue migration")
   val document=File(targetContext.cacheDir,"go-contract-document.txt")
   try{document.writeText("isolated file fixture");val upload=a.uploadMedia(document,"file","text/plain");val message=a.sendMediaMessage(cid,"file",upload,"android-media-file");check(message.getString("type")=="file")}finally{document.delete()}
   val oversized=File(targetContext.cacheDir,"go-contract-oversized.png")
   try{java.io.RandomAccessFile(oversized,"rw").use{it.setLength(10L*1024*1024+1)};try{a.uploadMedia(oversized,"image","image/png");error("oversized image accepted")}catch(e:ClientApiException){check(e.status==413)}}finally{oversized.delete()}
   checks.put("file upload and message metadata")
   args.getString("media_base")?.let{samples->
       require(samples.startsWith("http://10.0.2.2:")||samples.startsWith("http://127.0.0.1:"))
       val fixtureHTTP=okhttp3.OkHttpClient.Builder().callTimeout(20,TimeUnit.SECONDS).build()
       for((name,kind,mime) in listOf(Triple("test-audio.wav","voice","audio/wav"),Triple("test-video.mp4","video","video/mp4"))){
           val file=File(targetContext.cacheDir,name)
           try{
               fixtureHTTP.newCall(okhttp3.Request.Builder().url(samples+"/"+name).build()).execute().use{response->
                   check(response.isSuccessful);val body=requireNotNull(response.body)
                   body.byteStream().use{input->file.outputStream().use{output->input.copyTo(output)}}
                   check(file.length()==body.contentLength()){ "incomplete local fixture: $name" }
               }
               val upload=a.uploadMedia(file,kind,mime);val message=a.sendMediaMessage(gid,kind,upload,"android-media-"+kind);check(message.getString("type")==kind)
           }finally{file.delete()}
       }
       checks.put("real audio/video upload processing and message mapping")
   }
   val tasks=a.workTasks().getJSONArray("items")
   args.getString("task_code")?.let{code->
       check(tasks.length()>0)
       val started=a.startWorkTask(tasks.getJSONObject(0).getInt("id"),code)
       val record=started.getJSONObject("record").getInt("id");val questions=started.getJSONArray("questions");val answers=JSONObject()
       for(index in 0 until questions.length())answers.put(questions.getJSONObject(index).getString("question_uuid"),true)
       val saved=a.saveWorkTaskAnswers(record,answers).getJSONArray("questions")
       for(index in 0 until saved.length())check(saved.getJSONObject(index).getBoolean("answer"))
       check(WorkTaskSettlement.complete(a.submitWorkTask(record,answers)))
       check(WorkTaskSettlement.complete(a.workTaskRecord(record)))
       checks.put("task start, answer save, grading, wages and settlement reload")
   }
   checks.put("implemented task list contract")
   val stable=GoV2Ids.local(base,"user",alice.getString("wire_id"));check(stable==alice.getInt("id"));check(GoV2Ids.wire(base,"user",stable)==alice.getString("wire_id"));checks.put("persistent UUID mapping")
   AccountSessions(targetContext,base).save(alice,requireNotNull(a.token));b.logout();c.logout()
   result.putString("checks",checks.toString());result.putString("result","passed");finish(Activity.RESULT_OK,result)
  }catch(e:Throwable){result.putString("result","failed");result.putString("checks",checks.toString());result.putString("failure",android.util.Log.getStackTraceString(e));finish(Activity.RESULT_CANCELED,result)}finally{socket?.close()}
 }
}
