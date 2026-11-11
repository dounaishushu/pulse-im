package com.pulseim.android

import android.app.Instrumentation
import android.app.Activity
import android.os.Bundle
import org.json.JSONObject
import org.json.JSONArray
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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
   fun login(suffix:String)=ApiClient(base).apply{token=login(prefix+suffix,password)}
   val a=login("a");val b=login("b");val c=login("c")
   val alice=a.me();val bob=b.me();val carol=c.me()
   check(a.contacts().length()==0)
   val direct=a.createDirectConversation(carol.getInt("id"));val cid=direct.getInt("id")
   check(direct.getBoolean("temporary"));check(a.contacts().length()==0);checks.put("temporary chat does not create friendship")
   val sent=a.sendText(cid,"Android to Go message","android-probe-one")
   val duplicate=a.sendText(cid,"Android to Go message","android-probe-one")
   check(sent.getInt("id")==duplicate.getInt("id"));check(c.history(cid).length()==1);checks.put("text idempotency and history")
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
   try{b.requestJoinGroup(gid);error("public number interpreted as local handle")}catch(e:ClientApiException){check(e.status==501)}
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
   val cleared=c.clearHistory(gid);check(cleared.getInt("cleared_before_message_id")==old.getInt("id"))
   check(c.historyPage(gid).clearedBefore==old.getInt("id"))
   val newer=a.sendText(gid,"清空之后的消息","android-group-new")
   check(c.history(gid).length()==1)
   c.deleteMessages(gid,listOf(newer.getInt("id")));check(c.history(gid).length()==0);checks.put("personal clear and deletion")
   val req=b.sendFriendRequest(alice.getInt("id"),"Android friend request")
   a.handleFriendRequest(req.getInt("request_id"),"accept");check(a.contacts().length()==1);checks.put("friend request and acceptance")
   val ready=CountDownLatch(1);val changed=CountDownLatch(1)
   socket=SocketClient(base.replace("http://","ws://")+"/realtime",requireNotNull(a.token),{_,packet->if(packet.optString("type")=="go.changed")changed.countDown()},{_,connected->if(connected)ready.countDown()})
   socket.connect();check(ready.await(8,TimeUnit.SECONDS)){"ready timeout"};b.sendText(gid,"实时通知验证","android-websocket");check(changed.await(8,TimeUnit.SECONDS)){"hint timeout"};checks.put("single-use WebSocket ticket and change hints")
   socket.close();socket=null
   a.muteConversationMember(gid,bob.getInt("id"),-1)
   check(!b.groupProfile(gid).getBoolean("can_send"));check(b.groupProfile(gid).getString("send_disabled_reason")=="member_muted")
   try{b.sendText(gid,"must not send","android-probe-muted");error("mute bypass")}catch(e:ClientApiException){check(e.status==403)}
   a.muteConversationMember(gid,bob.getInt("id"),0);checks.put("permanent mute and unmute")
   try{a.workTasks();error("unsupported feature fabricated success")}catch(e:ClientApiException){check(e.status==501)};checks.put("unsupported feature stays explicit")
   val stable=GoV2Ids.local(base,"user",alice.getString("wire_id"));check(stable==alice.getInt("id"));check(GoV2Ids.wire(base,"user",stable)==alice.getString("wire_id"));checks.put("persistent UUID mapping")
   AccountSessions(targetContext,base).save(alice,requireNotNull(a.token));b.logout();c.logout()
   result.putString("checks",checks.toString());result.putString("result","passed");finish(Activity.RESULT_OK,result)
  }catch(e:Throwable){result.putString("result","failed");result.putString("checks",checks.toString());result.putString("failure",e.toString());finish(Activity.RESULT_CANCELED,result)}finally{socket?.close()}
 }
}
