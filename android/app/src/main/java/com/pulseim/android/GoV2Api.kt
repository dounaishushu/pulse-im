package com.pulseim.android

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** Compatibility with existing view models only; every request uses Go's UUID
 * resources. Unsupported business operations fail explicitly and never fall
 * through to PHP or fabricate server-side success. */
internal class GoV2Api(private val base:String, private val token:()->String?,private val http:(String,String,JSONObject?)->JSONObject){
    init { require(URI(base).rawQuery==null && URI(base).path.trimEnd('/').endsWith("/api/v2")){"Go 服务地址须以 /api/v2 结尾"} }
    private fun enc(v:String)=URLEncoder.encode(v,"UTF-8")
    private fun id(kind:String,value:String)=GoV2Ids.local(base,kind,value)
    private fun wire(kind:String,value:Int)=GoV2Ids.wire(base,kind,value)
    private fun num(v:String)=GoV2Ids.exact(v.toLong())
    private fun get(path:String)=http(path,"GET",null)
    private fun post(path:String,p:JSONObject=JSONObject())=http(path,"POST",p)
    private fun put(path:String,p:JSONObject=JSONObject())=http(path,"PUT",p)
    private fun unsupported():Nothing=throw ClientApiException(501,"feature_not_ready","当前服务暂未开放此功能")
    private fun user(v:JSONObject):JSONObject {
        val result=JSONObject(v.toString());val uid=id("user",v.getString("id"))
        return result.put("wire_id",v.getString("id")).put("id",uid).put("user_id",uid).put("username",v.optString("account"))
            .put("nickname",v.optString("nickname",v.optString("account"))).put("public_id","")
    }
    private fun currentUser():Int=id("user",get("/me").getString("user_id"))
    private fun displayTime(value:String):String = java.time.OffsetDateTime.parse(value)
        .atZoneSameInstant(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
    private fun message(v:JSONObject):JSONObject {
        val cid=id("conversation",v.getString("conversation_id"));val seq=num(v.getString("seq"));GoV2Ids.message(base,cid,v)
        val removed=v.optBoolean("revoked");val version=v.getString("version")
        return JSONObject().put("id",seq).put("wire_id",v.getString("id")).put("seq",v.getString("seq")).put("event_seq",v.getString("event_seq"))
            .put("version",version).put("_go_version",version.padStart(20,'0')).put("conversation_id",cid).put("sender_id",id("user",v.getString("sender_id"))).put("type","text")
            .put("body",JSONObject().put("text",if(removed) "" else v.optString("body")).put("request_id",v.getString("request_id")))
            .put("_wire_created_at",v.getString("created_at")).put("created_at",displayTime(v.getString("created_at"))).put("edited_at",if(version!="1") displayTime(v.getString("updated_at")) else JSONObject.NULL)
            .put("recalled_at",if(removed)v.getString("created_at") else JSONObject.NULL).put("status",if(removed)"recalled" else "sent")
    }
    private fun conversation(v:JSONObject,uid:Int):JSONObject {
        val cid=id("conversation",v.getString("id"));val peer=v.optString("peer_id");val kind=v.getString("kind")
        val reset=GoV2Ids.membership(base,uid,cid,v.getString("membership_version"),token());val st=v.getJSONObject("state")
        val role=v.optString("my_role");val canManage=role in listOf("owner","admin")
        return JSONObject(v.toString()).put("wire_id",v.getString("id")).put("id",cid).put("type",kind)
            .put("name",if(kind=="direct") v.optString("peer_name","临时聊天") else v.optString("title"))
            .put("peer_user_id",if(peer.isBlank())0 else id("user",peer)).put("peer_nickname",v.optString("peer_name"))
            .put("last_message",v.optJSONObject("last_message")?.let(::message)?:JSONObject.NULL)
            .put("unread_count",maxOf(v.optInt("unread_count"),if(st.optBoolean("reminder"))1 else 0))
            .put("cleared_before_message_id",maxOf(num(st.getString("clear_seq")),num(v.getString("visible_from_seq"))-1))
            .put("_membership_reset",reset).put("my_role",role).put("can_manage",canManage).put("can_invite",canManage).put("can_publish",kind!="channel"||canManage)
            .put("status","active").put("all_muted",v.optBoolean("mute_all")).put("send_disabled_reason",when{v.optBoolean("can_send")->"";v.optBoolean("my_muted")->"member_muted";v.optBoolean("mute_all")&&!canManage->"group_muted";kind=="direct"->"peer_unavailable";else->"account_muted"})
    }
    private fun all(path:String):JSONArray {
        val result=JSONArray();var after="";val seen=mutableSetOf<String>()
        repeat(1000){
            val page=get(path+(if(path.contains('?'))"&" else "?")+"after="+enc(after));val items=page.getJSONArray("items")
            for(i in 0 until items.length())result.put(items.get(i))
            val next=page.optString("next_after");if(next.isBlank())return result
            check(items.length()>0&&seen.add(next)){"服务器分页游标异常"};after=next
        };error("目录过大，请缩小范围")
    }
    private fun page(items:JSONArray,q:Map<String,String>):JSONObject {
        val page=(q["page"]?.toIntOrNull()?:1).coerceAtLeast(1);val size=(q["size"]?.toIntOrNull()?:50).coerceIn(1,100)
        val start=((page.toLong()-1)*size).coerceAtMost(items.length().toLong()).toInt()
        return JSONObject().put("items",JSONArray((start until minOf(start+size,items.length())).map{items.get(it)})).put("page",page).put("size",size).put("total",items.length()).put("has_more",start+size<items.length())
    }
    private fun map(items:JSONArray,convert:(JSONObject)->JSONObject)=JSONArray((0 until items.length()).map{convert(items.getJSONObject(it))})
    private fun info(cid:Int)=conversation(get("/conversations/${wire("conversation",cid)}"),currentUser())
    private fun group(cid:Int):JSONObject {
        val result=get("/groups/${wire("conversation",cid)}");val role=result.getString("my_role");val managers=role in listOf("owner","admin")
        val permission=info(cid)
        result.put("can_send",permission.getBoolean("can_send")).put("send_disabled_reason",permission.getString("send_disabled_reason"))
        return JSONObject(result.toString()).put("id",cid).put("type",result.getString("kind")).put("name",result.getString("title"))
            .put("can_manage",managers).put("can_invite",managers).put("is_owner",role=="owner")
            .put("allow_member_add_friend",!result.getBoolean("block_member_friend_requests"))
            .put("members_visibility",if(managers||!result.getBoolean("block_member_friend_requests"))"all" else "managers")
            .put("max_members",result.getInt("member_limit")).put("all_muted",result.getBoolean("mute_all"))
            .put("owner_id",result.optString("owner_id").takeIf{it.isNotBlank()}?.let{id("user",it)}?:0)
    }
    fun request(path:String,method:String,payload:JSONObject?):JSONObject {
        val uri=URI("https://local.invalid$path");val route=uri.path
        val q=uri.rawQuery.orEmpty().split('&').filter{it.isNotBlank()}.associate{val p=it.split('=',limit=2);URLDecoder.decode(p[0],"UTF-8") to URLDecoder.decode(p.getOrElse(1){""},"UTF-8")}
        val p=payload?:JSONObject()
        fun input(key:String)=if(p.has(key))p.getInt(key)else q[key]?.toIntOrNull()?:0
        fun cid()=input("conversation_id")
        fun cw()=wire("conversation",cid())
        fun mutation(route:String,method:String="POST",body:JSONObject=JSONObject()):JSONObject {http(route,method,body);return JSONObject().put("status","ok")}
        val data:Any=when(route){
            "/client/config"->get("/client/config")
            "/auth/login"->{if(p.optString("two_step_code").isNotBlank())unsupported();post("/auth/login",JSONObject().put("account",p.getString("phone")).put("password",p.getString("password")).put("device_id",p.getString("device_id")))}
            "/auth/me"->user(get("/me/profile"))
            "/auth/logout"->mutation("/auth/logout")
            "/auth/password"->mutation("/auth/password","PUT",p)
            "/auth/sessions"->JSONObject().put("items",map(get("/auth/sessions").getJSONArray("items")){v->JSONObject(v.toString()).put("id",id("session",v.getString("id"))).put("device_type","unknown").put("device_name",v.getString("device_id")).put("is_current",v.getBoolean("current"))})
            "/auth/sessions/revoke"->mutation("/auth/sessions/${wire("session",p.getInt("session_id"))}","DELETE")
            "/auth/settings"->if(method=="GET"){val v=get("/me/privacy");JSONObject().put("can_manage_privacy",v.getBoolean("can_manage_group_invites")).put("_go_privacy",v).put("invite_visibility",v.getJSONObject("group_invites").getString("visibility")).put("temporary_chat_visibility",v.getJSONObject("temporary_chat").getString("visibility"))}else unsupported()
            "/go/privacy"->if(method=="GET")get("/me/privacy")else http("/me/privacy","PATCH",p)
            "/contacts/search"->{if(q.containsKey("public_id"))unsupported();val account=q["keyword"]?:q["username"]?:q["q"]?:q["public_id"]?:"";val found=try{JSONArray().put(user(get("/users/by-account/${enc(account)}")))}catch(e:ClientApiException){if(e.status==404)JSONArray()else throw e};page(found,q)}
            "/contacts","/contacts/names"->if(q["all"]=="true")JSONObject().put("items",map(all("/client/friends"),::user))else get("/client/friend-page?page=${q["page"]?:"1"}&size=${q["size"]?:"50"}").let{v->v.put("items",map(v.getJSONArray("items"),::user))}
            "/contacts/profile"->user(get("/client/users/${wire("user",input("user_id"))}"+(input("context_conversation_id").takeIf{it>0}?.let{"?conversation_id=${wire("conversation",it)}"}?:"")))
            "/contacts/remove"->mutation("/friends/${wire("user",p.getInt("user_id"))}","DELETE")
            "/contacts/force-add"->{val v=post("/friends/direct-add",JSONObject().put("target_id",wire("user",p.getInt("user_id"))));JSONObject().put("conversation_id",id("conversation",v.getString("conversation_id"))).put("status","accepted").put("forced",true).put("user_id",p.getInt("user_id"))}
            "/contact-requests"->if(method=="GET"){
                val dir=if(q["direction"]=="sent")"outgoing" else "incoming"
                get("/client/friend-request-page?direction=$dir&page=${q["page"]?:"1"}&size=${q["size"]?:"20"}").let{page->page.put("items",map(page.getJSONArray("items")){v->JSONObject(v.toString()).put("id",id("request",v.getString("id"))).put("from_user_id",id("user",v.getString("requester_id"))).put("to_user_id",id("user",v.getString("target_id"))).put("from_nickname",v.optString("requester_account")).put("from_username",v.optString("requester_account")).put("message",v.optString("note"))})}
            }else{
                if(p.has("card_message_id"))unsupported()
                val body=JSONObject().put("target_id",wire("user",p.getInt("to_user_id"))).put("note",p.optString("message"))
                if(p.has("context_conversation_id"))body.put("context_conversation_id",wire("conversation",p.getInt("context_conversation_id")))
                val v=post("/friend-requests",body);JSONObject().put("request_id",id("request",v.getString("id"))).put("status","pending")
            }
            "/contact-requests/handle"->{val v=put("/friend-requests/${wire("request",p.getInt("request_id"))}/decision",JSONObject().put("accept",p.getString("action")=="accept"));JSONObject().put("status",if(p.getString("action")=="accept")"accepted" else "rejected").put("conversation_id",v.optString("conversation_id").takeIf{it.isNotBlank()}?.let{id("conversation",it)}?:0)}
            "/conversations"->{val uid=currentUser();get("/client/conversation-page?page=${q["page"]?:"1"}&size=${q["size"]?:"50"}&kind=${enc(q["type"].orEmpty())}").let{v->v.put("items",map(v.getJSONArray("items")){conversation(it,uid)})}}
            "/conversations/info","/conversations/open"->info(cid())
            "/conversations/direct"->{val v=post("/conversations/direct",JSONObject().put("peer_id",wire("user",p.getInt("user_id"))));info(id("conversation",v.getString("id")))}
            "/conversations/groups"->{if(p.optString("avatar_url").isNotBlank())unsupported();val members=p.optJSONArray("member_ids")?:JSONArray();val v=post("/groups",JSONObject().put("title",p.getString("name")).put("initial_members",JSONArray((0 until members.length()).map{wire("user",members.getInt(it))})).put("block_member_friend_requests",!p.optBoolean("allow_member_add_friend",true)));val cid=id("conversation",v.getString("id"));info(cid).put("invite_code",v.getString("invite_code"))}
            "/conversations/groups/join"->{val v=if(p.has("conversation_id"))unsupported() else post("/groups/join",JSONObject().put("invite_code",p.getString("invite_code")));JSONObject().put("conversation_id",id("conversation",v.getString("id"))).put("status","joined")}
            "/conversations/groups/profile"->if(method=="GET")group(cid())else{
                if(p.optString("avatar_url").isNotBlank())unsupported();val patch=JSONObject().put("title",p.getString("name")).put("description",p.optString("description")).put("announcement",p.optString("announcement"))
                if(p.has("allow_member_add_friend"))patch.put("block_member_friend_requests",!p.getBoolean("allow_member_add_friend"));http("/groups/${cw()}","PATCH",patch);group(cid())
            }
            "/conversations/members"->if(method=="GET")JSONObject().put("conversation_id",cid()).put("items",map(all("/groups/${cw()}/member-profiles")){v->user(v).put("user_id",id("user",v.getString("id"))).put("muted_until",if(v.getBoolean("muted"))"9999-12-31 23:59:59" else JSONObject.NULL)})else{
                require(p.has("allow_history")){"请选择是否允许查看历史消息"}
                post("/groups/${cw()}/members",JSONObject().put("target_id",wire("user",p.getInt("user_id"))).put("allow_history",p.getBoolean("allow_history")))
                JSONObject().put("conversation_id",cid()).put("user_id",p.getInt("user_id")).put("status","joined")
            }
            "/conversations/members/remove"->mutation("/groups/${cw()}/members/${wire("user",p.getInt("user_id"))}","DELETE")
            "/conversations/members/role"->mutation("/groups/${cw()}/members/${wire("user",p.getInt("user_id"))}/role","PUT",JSONObject().put("role",p.getString("role")))
            "/conversations/members/mute"->{require(p.getInt("minutes") in listOf(-1,0)){"当前服务只支持永久禁言或解除"};mutation("/groups/${cw()}/members/${wire("user",p.getInt("user_id"))}/muted","PUT",JSONObject().put("muted",p.getInt("minutes")==-1))}
            "/conversations/groups/transfer"->mutation("/groups/${cw()}/transfer",body=JSONObject().put("target_id",wire("user",p.getInt("user_id"))))
            "/conversations/groups/dissolve"->mutation("/groups/${cw()}","DELETE")
            "/conversations/leave"->mutation("/groups/${cw()}/members/${wire("user",currentUser())}","DELETE")
            "/blocks"->if(method=="GET")all("/blocks").let { values->page(JSONArray((0 until values.length()).map{index->JSONObject().put("user_id",id("user",values.getString(index))).put("blocked_id",id("user",values.getString(index))).put("nickname","已屏蔽用户")}),q) }else mutation("/blocks/${wire("user",p.getInt("user_id"))}","PUT")
            "/blocks/candidates"->{
                val blocked=all("/blocks").let{v->(0 until v.length()).map{v.getString(it)}.toSet()}
                val query=q["q"].orEmpty();val candidates=linkedMapOf<Int,JSONObject>()
                when(q["kind"]?:"contacts"){
                    "contacts"->{val rows=all("/client/friends");for(i in 0 until rows.length()){
                        val raw=rows.getJSONObject(i);if(raw.getString("id") !in blocked){val u=user(raw);candidates[u.getInt("user_id")]=u}
                    }}
                    "dialogs"->{val rows=all("/client/conversations");for(i in 0 until rows.length()){
                        val row=rows.getJSONObject(i);val peer=row.optString("peer_id")
                        if(row.optString("kind")=="direct"&&peer.isNotBlank()&&peer !in blocked){val uid=id("user",peer);candidates[uid]=JSONObject().put("user_id",uid).put("nickname",row.optString("peer_name")).put("username",row.optString("peer_name"))}
                    }}
                    else->unsupported()
                }
                page(JSONArray(candidates.values.filter{query.isBlank()||it.optString("nickname").contains(query,true)||it.optString("username").contains(query,true)}),q)
            }
            "/blocks/unblock"->mutation("/blocks/${wire("user",p.getInt("user_id"))}","DELETE")
            "/messages"->{if(p.getString("type")!="text")unsupported();val body=p.getJSONObject("body");if(body.has("reply_to_id")||body.has("mention_user_ids")||body.optBoolean("mention_all"))unsupported();val send=JSONObject().put("request_id",p.getString("request_id"));if(body.has("_source_wire_id"))send.put("source_message_id",body.getString("_source_wire_id"))else send.put("body",body.getString("text"));message(post("/conversations/${cw()}/messages",send).getJSONObject("message"))}
            "/messages/history","/messages/sync"->{
                val sync=route.endsWith("/sync");var url="/conversations/${cw()}/history?limit=${q["size"]?:q["limit"]?:"50"}&order=${if(sync)"asc" else "desc"}"
                if(sync){url+="&after_seq=${q["after_id"]?:"0"}&floor_seq=${q["floor_id"]?:"0"}";q["snapshot_max_id"]?.let{url+="&snapshot_max_seq=$it"}}
                else q["max_id"]?.let{url+="&before_seq=$it"}
                if(sync&&q.containsKey("snapshot_max_id")) {
                    val version=q["membership_version"]?.takeIf{it.toLongOrNull()?.let{v->v>0}==true}
                        ?:throw ClientApiException(409,"membership_changed","续页缺少成员版本，请重新同步")
                    url+="&membership_version="+enc(version)
                }
                val v=get(url)
                val uid=currentUser();val changed=GoV2Ids.membership(base,uid,cid(),v.getString("membership_version"),token())
                JSONObject().put("items",map(v.getJSONArray("items"),::message)).put("has_more",v.getBoolean("has_more"))
                    .put("snapshot_max_id",num(v.getString("snapshot_max_seq"))).put("next_after_id",num(v.getString("next_after_seq")))
                    .put("cleared_before_message_id",maxOf(num(v.getString("clear_seq")),num(v.getString("visible_from_seq"))-1)).put("membership_version",v.getString("membership_version")).put("_membership_reset",changed)
            }
            "/messages/receipt"->{val seq=p.getInt("through_message_id");put("/conversations/${cw()}/read",JSONObject().put("seq",seq.toString()));val unread=get("/conversations/${cw()}/unread");JSONObject().put("conversation_id",cid()).put("through_message_id",seq).put("unread_count",unread.getInt("count"))}
            "/messages/clear-history"->{val current=get("/conversations/${cw()}");val cleared=put("/conversations/${cw()}/clear",JSONObject().put("through_seq",current.getString("message_seq")));JSONObject().put("conversation_id",cid()).put("cleared_before_message_id",num(cleared.getString("clear_seq")))}
            "/messages/delete"->{val ids=p.getJSONArray("message_ids");post("/conversations/${cw()}/personal-deletions",JSONObject().put("message_ids",JSONArray((0 until ids.length()).map{GoV2Ids.message(base,cid(),ids.getInt(it)).first})));JSONObject().put("conversation_id",cid()).put("user_id",currentUser()).put("message_ids",ids)}
            "/messages/recall","/messages/edit"->{val ref=GoV2Ids.message(base,cid(),p.getInt("message_id"));val url="/conversations/${cw()}/messages/${ref.first}";message(if(route.endsWith("recall"))http(url,"DELETE",null)else http(url,"PATCH",JSONObject().put("body",p.getString("text")).put("expected_version",p.getString("expected_version"))))}
            "/messages/mark-unread"->{put("/conversations/${cw()}/reminder",JSONObject().put("reminder",true));JSONObject().put("conversation_id",cid()).put("status","unread")}
            else->unsupported()
        }
        return JSONObject().put("ok",true).put("data",data)
    }
}
