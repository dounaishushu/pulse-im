package com.pulseim.android

import org.json.JSONArray
import org.json.JSONObject
import android.util.Base64
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

/** Compatibility with existing view models only; every request uses Go's UUID
 * resources. Unsupported business operations fail explicitly and never fall
 * through to PHP or fabricate server-side success. */
internal class GoV2Api(private val base:String, private val token:()->String?,private val sessionVersion:()->Long,private val send:(String,String,JSONObject?,Long)->JSONObject){
    private val mediaGrants=ConcurrentHashMap<String,Pair<String,Long>>()
    private val requestSession = ThreadLocal<Long>()
    private var cachedSession = -1L
    private fun requireSession() {
        if (requestSession.get()?.let { it != sessionVersion() } == true) throw ClientApiException(409,"stale_session","账号已改变，本次操作已取消")
    }
    private fun http(path:String,method:String,body:JSONObject?):JSONObject {
        requireSession()
        val result=send(path,method,body,requestSession.get()?:sessionVersion())
        requireSession()
        return result
    }
    init { require(URI(base).rawQuery==null && URI(base).path.trimEnd('/').endsWith("/api/v2")){"Go 服务地址须以 /api/v2 结尾"} }
    private fun enc(v:String)=URLEncoder.encode(v,"UTF-8")
    private fun id(kind:String,value:String)=GoV2Ids.local(base,kind,value)
    private fun wire(kind:String,value:Int)=GoV2Ids.wire(base,kind,value)
    private fun num(v:String)=GoV2Ids.exact(v.toLong())
    private fun get(path:String)=http(path,"GET",null)
    private fun post(path:String,p:JSONObject=JSONObject())=http(path,"POST",p)
    private fun put(path:String,p:JSONObject=JSONObject())=http(path,"PUT",p)
    private fun unsupported():Nothing=throw ClientApiException(501,"feature_not_ready","当前服务暂未开放此功能")
    private fun mediaUrl(mediaId:String):String {
        if(mediaId.isBlank())return ""
        requireSession()
        val key="${requestSession.get()?:sessionVersion()}:$mediaId"
        val cached=mediaGrants[key]
        if(cached!=null&&cached.second>System.currentTimeMillis()+10_000)return cached.first
        val grant=post("/media/$mediaId/grants")
        val path=grant.getString("content_path")
        require(Regex("/api/v2/media-grants/[a-f0-9]{64}/content").matches(path)){"媒体授权地址无效"}
        val url=URI(RouteManager.api(base)).resolve(path).toString()
        requireSession()
        mediaGrants[key]=url to (System.currentTimeMillis()+minOf(120,grant.optInt("expires_in",120))*1000L)
        return url
    }
    private fun user(v:JSONObject):JSONObject {
        val result=JSONObject(v.toString());val uid=id("user",v.getString("id"))
        return result.put("wire_id",v.getString("id")).put("id",uid).put("user_id",uid).put("username",v.optString("account"))
            .put("nickname",v.optString("nickname",v.optString("account"))).put("avatar_url",avatarUrl(v.optString("avatar_id")))
            .put("signature",v.optString("bio")).put("last_seen_hidden",v.isNull("last_seen"))
    }
    private fun avatarUrl(mediaId:String):String = try { mediaUrl(mediaId) } catch(e:ClientApiException) {
        // An optional, now-inaccessible avatar must not hide the contact or roster.
        if(e.status==403||e.status==404) "" else throw e
    }
    private fun currentUser():Int=id("user",get("/me").getString("user_id"))
    private fun displayTime(value:String):String = java.time.OffsetDateTime.parse(value)
        .atZoneSameInstant(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
    private fun hydrateReplies(rows:JSONArray) {
        val groups=(0 until rows.length()).map{rows.getJSONObject(it)}.filter{it.optString("reply_to_id").isNotBlank()&&!it.optBoolean("revoked")}.groupBy{it.getString("conversation_id")}
        groups.forEach{(cid,children)->
            val result=post("/conversations/$cid/reply-contexts",JSONObject().put("message_ids",JSONArray(children.map{it.getString("id")}))).getJSONArray("items")
            val contexts=(0 until result.length()).map{result.getJSONObject(it)}.associateBy{it.getString("message_id")}
            children.forEach{it.put("_go_reply",contexts.getValue(it.getString("id")))}
        }
    }
    private fun messages(rows:JSONArray):JSONArray {hydrateReplies(rows);return map(rows,::message)}
    private fun message(v:JSONObject):JSONObject=messageView(v,true)
    private fun messageView(v:JSONObject,withReply:Boolean):JSONObject {
        val cid=id("conversation",v.getString("conversation_id"));val seq=num(v.getString("seq"));GoV2Ids.message(base,cid,v)
        val removed=v.optBoolean("revoked");val version=v.getString("version")
        val kind=v.optString("kind","text");val content=v.optJSONObject("content")?:JSONObject();val body=JSONObject(content.toString())
            .put("text",if(removed) "" else v.optString("body")).put("request_id",v.getString("request_id"))
        content.optJSONObject("media")?.let{media->
            body.put("url",mediaUrl(media.getString("id"))).put("mime",media.optString("mime"))
                .put("size",media.optLong("bytes")).put("name",media.optString("filename"))
                .put("width",media.optInt("width")).put("height",media.optInt("height"))
                .put("duration_ms",media.optLong("duration_ms")).put("original",media.optBoolean("original"))
                .put("_go_media_id",media.getString("id"))
        }
        content.optJSONObject("contact")?.let{contact->
            body.put("user_id",id("user",contact.getString("id"))).put("nickname",contact.optString("nickname"))
                .put("username",contact.optString("account")).put("public_id",contact.optString("public_id"))
        }
        content.optJSONArray("mentions")?.let{mentions->body.put("mention_user_ids",JSONArray((0 until mentions.length()).map{id("user",mentions.getString(it))}))}
        if(withReply&&v.optString("reply_to_id").isNotBlank()&&!removed){
            if(!v.has("_go_reply"))hydrateReplies(JSONArray().put(v))
            val context=v.getJSONObject("_go_reply");val seq=num(context.getString("reply_seq"));body.put("reply_to_id",seq)
            val parent=context.optJSONObject("message")?.let{messageView(it,false)}
            val quote=JSONObject().put("id",seq).put("unavailable",parent==null)
            if(parent!=null){val parentBody=parent.getJSONObject("body");quote.put("sender_id",parent.getInt("sender_id")).put("sender_name","会话成员").put("type",parent.getString("type")).put("text",parentBody.optString("text").ifBlank{when(parent.getString("type")){"image"->"图片";"video"->"视频";"voice"->"语音";"file"->parentBody.optString("name","文件");else->"消息"}}).put("thumbnail_url",if(parent.getString("type")=="image")parentBody.optString("url") else "")}
            body.put("reply_to",quote)
        }
        return JSONObject().put("id",seq).put("wire_id",v.getString("id")).put("seq",v.getString("seq")).put("event_seq",v.getString("event_seq"))
            .put("version",version).put("_go_version",version.padStart(20,'0')).put("conversation_id",cid).put("sender_id",id("user",v.getString("sender_id")))
            .put("type",when(kind){"audio"->"voice";"contact"->"contact_card";else->kind})
            .put("body",body)
            .put("_wire_created_at",v.getString("created_at")).put("created_at",displayTime(v.getString("created_at"))).put("edited_at",if(version!="1") displayTime(v.getString("updated_at")) else JSONObject.NULL)
            .put("recalled_at",if(removed)v.getString("created_at") else JSONObject.NULL).put("status",if(removed)"recalled" else "sent")
    }
    private fun conversation(v:JSONObject,uid:Int):JSONObject {
        val cid=id("conversation",v.getString("id"));val peer=v.optString("peer_id");val kind=v.getString("kind")
        val reset=GoV2Ids.membership(base,uid,cid,v.getString("membership_version"),token());val st=v.getJSONObject("state")
        val role=v.optString("my_role");val canManage=role in listOf("owner","admin")
        return JSONObject(v.toString()).put("wire_id",v.getString("id")).put("id",cid).put("type",kind)
            .put("name",if(kind=="direct") v.optString("peer_name","临时聊天") else v.optString("title"))
            .put("avatar_url",avatarUrl(v.optString("avatar_id"))).put("is_pinned",v.optBoolean("pinned"))
            .put("notifications_muted",v.optBoolean("muted_notifications")).put("is_archived",v.optBoolean("archived"))
            .put("peer_user_id",if(peer.isBlank())0 else id("user",peer)).put("peer_nickname",v.optString("peer_name"))
            .put("last_message",v.optJSONObject("last_message")?.let(::message)?:JSONObject.NULL)
            .put("unread_count",maxOf(v.optInt("unread_count"),if(st.optBoolean("reminder"))1 else 0))
            .put("cleared_before_message_id",maxOf(num(st.getString("clear_seq")),num(v.getString("visible_from_seq"))-1))
            .put("is_hidden",v.optBoolean("hidden")).put("folder_id",v.optString("folder_id").takeIf{it.isNotBlank()}?.let{id("folder",it)}?:0)
            .put("_membership_reset",reset).put("my_role",role).put("can_manage",canManage).put("can_invite",canManage).put("can_publish",kind!="channel"||canManage)
            .put("status","active").put("all_muted",v.optBoolean("mute_all")).put("send_disabled_reason",when{v.optBoolean("can_send")->"";v.optBoolean("my_muted")->"member_muted";v.optBoolean("mute_all")&&!canManage->"group_muted";kind=="direct"->"peer_unavailable";else->"account_muted"})
    }
    private fun all(path:String):JSONArray {
        val result=JSONArray();var after="";val seen=mutableSetOf<String>()
        repeat(1000){
            val page=get(path+(if(path.contains('?'))"&" else "?")+"after="+enc(after));val items=page.getJSONArray("items")
            for(i in 0 until items.length())result.put(items.get(i))
            val next=page.optString("next_after");if(next.isBlank())return result
            check(next!=after&&seen.add(next)){"服务器分页游标异常"};after=next
        };error("目录过大，请缩小范围")
    }
    private fun page(items:JSONArray,q:Map<String,String>):JSONObject {
        val page=(q["page"]?.toIntOrNull()?:1).coerceAtLeast(1);val size=(q["size"]?.toIntOrNull()?:50).coerceIn(1,100)
        val start=((page.toLong()-1)*size).coerceAtMost(items.length().toLong()).toInt()
        return JSONObject().put("items",JSONArray((start until minOf(start+size,items.length())).map{items.get(it)})).put("page",page).put("size",size).put("total",items.length()).put("has_more",start+size<items.length())
    }
    private fun legacySettings(privacy:JSONObject,profile:JSONObject):JSONObject {
        val exceptions=JSONObject()
        listOf("phone_visibility_always" to ("phone" to "allow"),"phone_search_always" to ("phone_search" to "allow"),"last_seen_never" to ("last_seen" to "deny"),"voice_call_never" to ("voice_call" to "deny"),"invite_never" to ("group_invites" to "deny")).forEach{(key,pair)->
            val source=privacy.optJSONObject(pair.first)?.optJSONArray(pair.second)?:JSONArray()
            exceptions.put(key,JSONArray((0 until source.length()).map{index->id("user",source.getString(index))}))
        }
        return JSONObject().put("can_manage_privacy",privacy.optBoolean("can_manage_group_invites"))
            .put("phone_visibility",privacy.getJSONObject("phone").getString("visibility"))
            .put("phone_search_visibility",privacy.getJSONObject("phone_search").getString("visibility"))
            .put("last_seen_visibility",privacy.getJSONObject("last_seen").getString("visibility"))
            .put("voice_call_visibility",privacy.getJSONObject("voice_call").getString("visibility"))
            .put("voice_call_peer_to_peer",privacy.optString("voice_call_peer_to_peer","everyone"))
            .put("invite_visibility",privacy.getJSONObject("group_invites").getString("visibility"))
            .put("temporary_chat_visibility",privacy.getJSONObject("temporary_chat").getString("visibility"))
            .put("show_active_sessions",privacy.optBoolean("show_active_sessions",true))
            .put("account_auto_delete_days",profile.optInt("inactivity_days",180)).put("privacy_exceptions",exceptions)
    }
    private fun taskRecord(raw:JSONObject):JSONObject {
        val result=JSONObject(raw.toString());val wireTask=raw.getString("task_id");val wireRecord=raw.getString("id")
        result.put("id",id("record",wireRecord)).put("task_id",id("task",wireTask)).put("user_id",id("user",raw.getString("user_id")))
        result.put("nickname",raw.optString("nickname")).put("avatar_url",mediaUrl(raw.optString("avatar_id")))
            .put("task_name",raw.optString("task_name")).put("status_label",when(raw.optString("status")){"in_progress"->"进行中";"pending_review"->"待审核";"reviewed"->"已完成";else->raw.optString("status")})
            .put("total_questions",raw.optInt("total")).put("wrong_count",raw.optInt("total")-raw.optInt("correct_count"))
            .put("unit_price",raw.optDouble("unit_price",0.0)).put("wage",raw.optDouble("wage",0.0))
            .put("start_at",raw.optString("started_at")).put("submitted_at",raw.optString("submitted_at")).put("reviewed_at",raw.optString("reviewed_at"))
        val questions=raw.optJSONArray("questions")?:JSONArray();val mapped=JSONArray();val savedAnswers=JSONObject()
        for(i in 0 until questions.length()){
            val question=questions.getJSONObject(i);val code=question.optString("code",question.getString("id"));val row=JSONObject()
                .put("question_uuid",code)
                .put("image_url",if(question.optString("media_id").isNotBlank())mediaUrl(question.getString("media_id")) else question.optString("image_url"))
                .put("answer",raw.optJSONObject("answers")?.opt(question.getString("id"))?:JSONObject.NULL)
            val resultValue=raw.optJSONObject("results")?.opt(question.getString("id"))
            row.put("reviewed_correct",resultValue?:JSONObject.NULL).put("correct_answer",question.opt("correct")?:JSONObject.NULL)
            if(!row.isNull("answer"))savedAnswers.put(code,row.getBoolean("answer"))
            mapped.put(row)
        }
        return JSONObject().put("record",result).put("questions",mapped).put("answers",savedAnswers)
    }
    private fun taskRecordWire(localId:Int)=wire("record",localId)
    private fun saveWorkAnswers(p:JSONObject,submit:Boolean):JSONObject {
        val localRecord=p.getInt("record_id");val recordID=taskRecordWire(localRecord);val record=get("/task-records/$recordID")
        val questions=record.optJSONArray("questions")?:JSONArray();val input=p.optJSONObject("answers")?:JSONObject();val answers=JSONObject()
        val byCode=(0 until questions.length()).associate{index->val question=questions.getJSONObject(index);question.optString("code",question.getString("id")) to question.getString("id")}
        val iterator=input.keys();while(iterator.hasNext()){val key=iterator.next();val wireID=byCode[key]?:key.takeIf{runCatching{java.util.UUID.fromString(it)}.isSuccess}?:error("题目标识无效");answers.put(wireID,input.optBoolean(key))}
        val payload=JSONObject().put("answers",answers).put("expected_version",record.getString("version"))
        return taskRecord(put("/task-records/$recordID/${if(submit)"submit" else "answers"}",payload))
    }
    private fun workTaskPage():JSONObject {
        val raw=get("/tasks?page=1&size=100");val rows=raw.optJSONArray("items")?:JSONArray();val mapped=JSONArray();val now=java.time.LocalTime.now(java.time.ZoneId.of("Asia/Shanghai"))
        for(index in 0 until rows.length()){
            val task=rows.getJSONObject(index);val taskID=id("task",task.getString("id"));val rawOpen=task.optString("open_time","00:00:00");val open=runCatching{java.time.LocalTime.parse(rawOpen)}.getOrDefault(java.time.LocalTime.MIDNIGHT)
            val record=task.optJSONObject("record")?.let{taskRecord(it).getJSONObject("record")}
            val status=task.optString("record_status").takeIf{it.isNotBlank()&&it!="null"}?:if(now<open)"not_started" else "available"
            mapped.put(JSONObject(task.toString()).put("id",taskID).put("open_time",rawOpen.take(5)).put("status",status)
                .put("status_label",when(status){"reviewed"->"已完成";"in_progress"->"继续答题";"pending_review"->"等待审核";"not_started"->"未开始";else->"开始答题"})
                .put("record",record?:JSONObject.NULL))
        }
        return JSONObject(raw.toString()).put("items",mapped)
    }
    private fun map(items:JSONArray,convert:(JSONObject)->JSONObject)=JSONArray((0 until items.length()).map{convert(items.getJSONObject(it))})
    private fun info(cid:Int)=conversation(get("/conversations/${wire("conversation",cid)}"),currentUser())
    private fun pins(cid:Int):JSONObject {
        val result=get("/conversations/${wire("conversation",cid)}/pins")
        val items=result.getJSONArray("items");hydrateReplies(items)
        return result.put("conversation_id",cid).put("limit",20).put("items",map(items){raw->
            val item=message(raw)
            raw.optJSONObject("pin")?.let{pin->item.put("pin",JSONObject(pin.toString()).put("pinned_by",id("user",pin.getString("pinned_by"))))}
            item
        })
    }
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
        val expected=sessionVersion()
        synchronized(mediaGrants) { if(cachedSession!=expected){mediaGrants.clear();cachedSession=expected} }
        val prior=requestSession.get()
        requestSession.set(expected)
        try {
            val result=requestCurrent(path,method,payload)
            requireSession()
            return result
        } finally {
            if(prior==null)requestSession.remove()else requestSession.set(prior)
        }
    }
    private fun requestCurrent(path:String,method:String,payload:JSONObject?):JSONObject {
        val uri=URI("https://local.invalid$path");val route=uri.path
        val q=uri.rawQuery.orEmpty().split('&').filter{it.isNotBlank()}.associate{val p=it.split('=',limit=2);URLDecoder.decode(p[0],"UTF-8") to URLDecoder.decode(p.getOrElse(1){""},"UTF-8")}
        val p=payload?:JSONObject()
        fun input(key:String)=if(p.has(key))p.getInt(key)else q[key]?.toIntOrNull()?:0
        fun cid()=input("conversation_id")
        fun cw()=wire("conversation",cid())
        fun mutation(route:String,method:String="POST",body:JSONObject=JSONObject()):JSONObject {http(route,method,body);return JSONObject().put("status","ok")}
        val data:Any=when(route){
            "/client/config"->{
                val raw=get("/client/config");val release=raw.optJSONObject("releases")?.optJSONObject("android")?:JSONObject();val notice=raw.optJSONObject("announcement")?:JSONObject();val registration=raw.optJSONObject("registration")?:JSONObject()
                fun links(key:String):JSONArray{val rows=raw.optJSONArray(key)?:JSONArray();return JSONArray((0 until rows.length()).map{index->val row=rows.getJSONObject(index);JSONObject().put("id",index+1).put("name",row.optString("title")).put("url",row.optString("url"))})}
                JSONObject(raw.toString()).put("chat_notice",notice.optString("body")).put("announcement",JSONObject().put("id",1).put("title",notice.optString("title")).put("content",notice.optString("body")).put("enabled",notice.optBoolean("enabled")).put("revision",raw.optString("announcement_version","1").toLongOrNull()?:1L))
                    .put("group_member_limit",raw.optInt("group_member_limit",500)).put("explore_links",links("navigation")).put("mall_links",links("shops"))
                    .put("show_group_member_count",raw.optJSONObject("display")?.optBoolean("show_group_count",true)?:true).put("latest_version",release.optString("latest","1.0.0"))
                    .put("minimum_version",release.optString("minimum")).put("android_download_url",release.optString("url")).put("ios_download_url","")
                    .put("update_description",release.optString("notes")).put("force_update",release.optBoolean("force"))
                    .put("register_require_avatar",raw.optBoolean("registration_avatar_required")).put("max_register_accounts_per_ip",registration.optInt("per_ip_limit"))
            }
            "/client/routes"->{val config=get("/client/config");val routes=config.optJSONArray("routes")?:JSONArray();JSONObject().put("items",JSONArray((0 until routes.length()).map{index->val row=routes.getJSONObject(index);JSONObject().put("id",index+1).put("name",row.optString("name")).put("url",row.optString("api_url")).put("sort",row.optInt("sort_order")).put("status",if(row.optBoolean("enabled"))"active" else "disabled").put("ws_url",row.optString("ws_url")).put("media_url",row.optString("media_url"))}))}
            "/work-tasks"->workTaskPage()
            "/work-tasks/start"->{val raw=post("/tasks/${wire("task",p.getInt("task_id"))}/start",JSONObject().put("code",p.getString("verification_code")));taskRecord(raw)}
            "/work-tasks/record"->{val recordID=taskRecordWire(input("id"));taskRecord(get("/task-records/$recordID"))}
            "/work-tasks/answers"->saveWorkAnswers(p,false)
            "/work-tasks/submit"->saveWorkAnswers(p,true)
            "/auth/register-challenge"->{val captcha=get("/auth/captcha");JSONObject().put("challenge_id",captcha.getString("id"))
                .put("image_data_url",captcha.getString("image")).put("code_length",5).put("expires_in",captcha.getInt("expires_in"))}
            "/auth/register"->{
                val identity=p.optString("username",p.optString("phone"));val phone=if(identity.matches(Regex("[0-9+ -]{6,32}")))identity else ""
                val avatar=p.optString("avatar_data_url").ifBlank{p.optString("avatar_url")};val image=avatar.substringAfter("base64,","")
                val register=JSONObject().put("account",if(phone.isBlank())identity else "").put("phone",phone)
                    .put("nickname",p.getString("nickname")).put("password",p.getString("password"))
                    .put("captcha_id",p.getString("captcha_id")).put("captcha_code",p.getString("captcha_code"))
                if(image.isNotBlank()){
                    val mime=avatar.substringAfter("data:","").substringBefore(';').takeIf{it in listOf("image/jpeg","image/png","image/webp")}?:"image/jpeg"
                    register.put("avatar_filename",if(mime=="image/png")"avatar.png" else if(mime=="image/webp")"avatar.webp" else "avatar.jpg").put("avatar_base64",image)
                }
                val created=post("/auth/register",register);val wireId=created.getString("id")
                val login=post("/auth/login",JSONObject().put("account",identity).put("password",p.getString("password"))
                    .put("device_id",p.getString("device_id")).put("device_name",p.optString("device_name"))
                    .put("platform","android"))
                JSONObject(login.toString()).put("user_id",id("user",wireId))
                    .put("public_id",wireId.replace("-","").uppercase(java.util.Locale.ROOT)).put("avatar_url","")
            }
            "/auth/login"->post("/auth/login",JSONObject().put("account",p.getString("phone")).put("password",p.getString("password"))
                .put("device_id",p.getString("device_id")).put("device_name",p.optString("device_name")).put("platform","android").put("second_factor",p.optString("two_step_code")))
            "/auth/me"->user(get("/me/profile"))
            "/auth/profile"->{
                val current=get("/me/profile");val patch=JSONObject().put("expected_version",current.getString("version"))
                listOf("nickname" to "nickname","username" to "account","birthday" to "birthday","gender" to "gender","signature" to "bio").forEach{(old,next)->if(p.has(old))patch.put(next,p.get(old))}
                if(patch.length()>1)http("/me/profile","PATCH",patch)
                val avatar=Regex("^pulse-media:([0-9a-f-]{36})$").matchEntire(p.optString("avatar_url"))?.groupValues?.get(1)
                if(avatar!=null){val latest=get("/me/profile");put("/me/avatar",JSONObject().put("media_id",avatar).put("expected_version",latest.getString("version")))}
                user(get("/me/profile"))
            }
            "/auth/logout"->mutation("/auth/logout")
            "/notifications/devices/register"->{val v=put("/me/push-device",JSONObject().put("platform","android").put("token",p.getString("device_token")));JSONObject().put("status",if(v.optBoolean("registered"))"registered" else "failed")}
            "/notifications/devices/unregister"->mutation("/me/push-device","DELETE")
            "/notifications/devices"->get("/me/push-devices").let{v->v.put("items",map(v.getJSONArray("items")){item->JSONObject(item.toString()).put("id",id("push_device",item.getString("id")))})}
            "/notifications/friend-chats"->get("/friend-chats?after_id=${q["after_id"]?:"0"}").let{v->val items=v.optJSONArray("items")?:JSONArray();for(i in 0 until items.length()){val item=items.getJSONObject(i);item.put("id",num(item.getString("id"))).put("conversation_id",id("conversation",item.getString("conversation_id"))).put("peer_user_id",id("user",item.getString("peer_user_id")))};v}
            "/auth/password"->mutation("/auth/password","PUT",p)
            "/auth/sessions"->JSONObject().put("items",map(get("/auth/sessions").getJSONArray("items")){v->JSONObject(v.toString()).put("id",id("session",v.getString("id"))).put("device_type","unknown").put("device_name",v.getString("device_id")).put("is_current",v.getBoolean("current"))})
            "/auth/sessions/revoke"->mutation("/auth/sessions/${wire("session",p.getInt("session_id"))}","DELETE")
            "/auth/settings"->{
                val current=get("/me/privacy");val profile=get("/me/profile")
                if(method!="GET"){
                    val settings=p.optJSONObject("settings")?:p;val patch=JSONObject().put("expected_version",current.getString("version"))
                    val scopes=mapOf("phone_visibility" to "phone","phone_search_visibility" to "phone_search","last_seen_visibility" to "last_seen","voice_call_visibility" to "voice_call","invite_visibility" to "group_invites")
                    for((old,scope) in scopes)if(settings.has(old))patch.put(scope,JSONObject(current.getJSONObject(scope).toString()).put("visibility",settings.getString(old)))
                    settings.optJSONObject("privacy_exceptions")?.let{exceptions->
                        val mapping=listOf(Triple("phone_visibility_always","phone","allow"),Triple("phone_search_always","phone_search","allow"),Triple("last_seen_never","last_seen","deny"),Triple("voice_call_never","voice_call","deny"),Triple("invite_never","group_invites","deny"))
                        for((old,scope,effect) in mapping)if(exceptions.has(old)){
                            val ids=exceptions.getJSONArray(old);patch.put(scope,JSONObject((patch.optJSONObject(scope)?:current.getJSONObject(scope)).toString()).put(effect,JSONArray((0 until ids.length()).map{wire("user",ids.getInt(it))})))
                        }
                    }
                    if(settings.has("voice_call_peer_to_peer"))patch.put("voice_call_peer_to_peer",settings.getString("voice_call_peer_to_peer"))
                    if(settings.has("show_active_sessions"))patch.put("show_active_sessions",settings.getBoolean("show_active_sessions"))
                    if(patch.length()>1)http("/me/privacy","PATCH",patch)
                    if(settings.has("account_auto_delete_days"))http("/me/profile","PATCH",JSONObject().put("inactivity_days",settings.getInt("account_auto_delete_days")).put("expected_version",profile.getString("version")))
                }
                legacySettings(get("/me/privacy"),get("/me/profile"))
            }
            "/auth/security"->if(method=="GET")get("/me/security")else put("/me/security",JSONObject()
                .put("action",p.getString("action")).put("login_password",p.optString("login_password"))
                .put("current",p.optString("current",p.optString("current_code")))
                .put("next",p.optString("next",p.optString("new_password"))))
            "/go/privacy"->if(method=="GET")get("/me/privacy")else http("/me/privacy","PATCH",p)
            "/contacts/search"->{val publicID=q["public_id"];val account=q["keyword"]?:q["username"]?:q["q"]?:"";val endpoint=if(publicID!=null){require(PublicUserId.value(publicID)==publicID){"用户 ID 无效"};"/public-users/${enc(publicID)}"}else "/users/by-account/${enc(account)}";val found=try{JSONArray().put(user(get(endpoint)))}catch(e:ClientApiException){if(e.status==404)JSONArray()else throw e};page(found,if(publicID!=null)mapOf("page" to "1","size" to "1")else q)}
            "/contacts","/contacts/names"->if(q["all"]=="true")JSONObject().put("items",map(all("/client/friends"),::user))else get("/client/friend-page?page=${q["page"]?:"1"}&size=${q["size"]?:"50"}").let{v->v.put("items",map(v.getJSONArray("items"),::user))}
            "/contacts/profile"->user(get("/profiles/${wire("user",input("user_id"))}"+(input("context_conversation_id").takeIf{it>0}?.let{"?conversation_id=${wire("conversation",it)}"}?:"")))
            "/contacts/remark"->{val peer=wire("user",p.getInt("user_id"));val current=get("/profiles/$peer");val remark=p.optString("remark",current.optString("remark"));val group=p.optString("group_name",current.optString("group_name"));put("/friends/$peer/metadata",JSONObject().put("remark",remark).put("group_name",group).put("expected_version",current.optString("contact_version","0")));JSONObject().put("user_id",p.getInt("user_id")).put("remark",remark).put("group_name",group)}
            "/contacts/internal-profile"->{
                val uid=wire("user",input("user_id"));val context=input("context_conversation_id").takeIf{it>0}?.let{"?conversation_id=${wire("conversation",it)}"}?:"";val raw=get("/staff/users/$uid$context")
                val logins=raw.optJSONArray("logins")?:JSONArray();val last=logins.optJSONObject(0)?:JSONObject()
                JSONObject().put("user_id",id("user",raw.getString("id"))).put("nickname",raw.optString("nickname")).put("phone",raw.optString("phone"))
                    .put("register_ip",raw.optString("registration_ip")).put("last_login_ip",last.optString("ip")).put("last_login_at",last.optString("created_at"))
                    .put("last_login_device",last.optString("device_name")).put("public_id",raw.optString("public_id"))
            }
            "/contacts/legacy-profile"->user(get("/public-users/legacy/${input("legacy_user_id")}"))
            "/contacts/card-profile"->{
                val conversation=input("conversation_id");val message=GoV2Ids.message(base,conversation,input("message_id")).first
                val raw=get("/conversations/${wire("conversation",conversation)}/messages/$message/contact");val profile=user(raw.getJSONObject("user"))
                profile.put("is_contact",raw.optBoolean("is_contact")).put("can_add_friend",raw.optBoolean("can_add_friend"))
                    .put("add_friend_restriction",raw.optString("add_friend_restriction")).put("source_conversation_id",conversation).put("source_message_id",input("message_id"))
            }
            "/contacts/common-groups"->{
                val peer=wire("user",input("user_id"));val context=input("context_conversation_id").takeIf{it>0}?.let{"&conversation_id=${wire("conversation",it)}"}?:""
                val result=get("/profiles/$peer/common-groups?page=${q["page"]?:"1"}&size=${q["size"]?:"20"}$context")
                result.put("items",map(result.getJSONArray("items")){raw->JSONObject().put("id",id("conversation",raw.getString("id"))).put("type","group").put("name",raw.optString("title")).put("status","active")})
            }
            "/contacts/remove"->mutation("/friends/${wire("user",p.getInt("user_id"))}","DELETE")
            "/contacts/force-add"->{val v=post("/friends/direct-add",JSONObject().put("target_id",wire("user",p.getInt("user_id"))));JSONObject().put("conversation_id",id("conversation",v.getString("conversation_id"))).put("status","accepted").put("forced",true).put("user_id",p.getInt("user_id"))}
            "/contact-requests"->if(method=="GET"){
                val dir=if(q["direction"]=="sent")"outgoing" else "incoming"
                get("/client/friend-request-page?direction=$dir&page=${q["page"]?:"1"}&size=${q["size"]?:"20"}&status=${enc(q["status"].orEmpty())}").let{page->page.put("items",map(page.getJSONArray("items")){v->JSONObject(v.toString()).put("id",id("request",v.getString("id"))).put("from_user_id",id("user",v.getString("requester_id"))).put("to_user_id",id("user",v.getString("target_id"))).put("from_nickname",v.optString("requester_account")).put("from_username",v.optString("requester_account")).put("message",v.optString("note"))})}
            }else{
                val body=JSONObject().put("target_id",wire("user",p.getInt("to_user_id"))).put("note",p.optString("message"))
                if(p.has("context_conversation_id"))body.put("context_conversation_id",wire("conversation",p.getInt("context_conversation_id")))
                if(p.has("card_message_id")){
                    val conversation=p.getInt("card_conversation_id");val message=p.getInt("card_message_id")
                    body.put("card_conversation_id",wire("conversation",conversation)).put("card_message_id",GoV2Ids.message(base,conversation,message).first)
                }
                val v=post("/friend-requests",body);JSONObject().put("request_id",id("request",v.getString("id"))).put("status",v.getString("status")).put("conversation_id",v.optString("conversation_id").takeIf{it.isNotBlank()}?.let{id("conversation",it)}?:0)
            }
            "/contact-requests/handle"->{val v=put("/friend-requests/${wire("request",p.getInt("request_id"))}/decision",JSONObject().put("accept",p.getString("action")=="accept"));JSONObject().put("status",if(p.getString("action")=="accept")"accepted" else "rejected").put("conversation_id",v.optString("conversation_id").takeIf{it.isNotBlank()}?.let{id("conversation",it)}?:0)}
            "/conversations"->{val uid=currentUser();get("/client/conversation-page?page=${q["page"]?:"1"}&size=${q["size"]?:"50"}&kind=${enc(q["type"].orEmpty())}").let{v->v.put("items",map(v.getJSONArray("items")){conversation(it,uid)})}}
            "/conversations/subscriptions"->{val rows=all("/client/conversations");JSONObject().put("items",map(rows){row->JSONObject().put("conversation_id",id("conversation",row.getString("id"))).put("last_message_id",row.optJSONObject("last_message")?.let{num(it.getString("seq"))}?:0)})}
            "/conversations/updates"->{val values=(q["ids"]?:"").split(',').filter{it.isNotBlank()}.map{info(it.toInt())};JSONObject().put("items",JSONArray(values))}
            "/conversations/settings","/conversations/hide"->{val item=info(cid());val patch=JSONObject().put("expected_version",item.getString("preference_version"));if(p.has("is_pinned"))patch.put("pinned",p.getBoolean("is_pinned"));if(p.has("notifications_muted"))patch.put("muted_notifications",p.getBoolean("notifications_muted"));if(p.has("is_archived"))patch.put("archived",p.getBoolean("is_archived"));if(route.endsWith("/hide"))patch.put("hidden",true);if(patch.length()>1)http("/conversations/${cw()}/preferences","PATCH",patch);if(route.endsWith("/hide"))JSONObject().put("conversation_id",cid()).put("status","hidden")else info(cid())}
            "/conversations/favorites"->{val value=post("/conversations/saved");info(id("conversation",value.getString("id")))}
            "/conversations/info"->info(cid())
            "/conversations/open"->{val item=info(cid());if(item.optBoolean("is_hidden")){http("/conversations/${cw()}/preferences","PATCH",JSONObject().put("hidden",false).put("expected_version",item.getString("preference_version")))};JSONObject().put("conversation_id",cid()).put("status","visible")}
            "/conversations/direct"->{val v=post("/conversations/direct",JSONObject().put("peer_id",wire("user",p.getInt("user_id"))));info(id("conversation",v.getString("id")))}
            "/conversations/groups"->{val members=p.optJSONArray("member_ids")?:JSONArray();val avatar=Regex("^pulse-media:([0-9a-f-]{36})$").matchEntire(p.optString("avatar_url"))?.groupValues?.get(1);val body=JSONObject().put("title",p.getString("name")).put("initial_members",JSONArray((0 until members.length()).map{wire("user",members.getInt(it))})).put("block_member_friend_requests",!p.optBoolean("allow_member_add_friend",true));if(avatar!=null)body.put("avatar_id",avatar);val v=post("/groups",body);val cid=id("conversation",v.getString("id"));info(cid).put("invite_code",v.getString("invite_code"))}
            "/conversations/channels"->{val v=post("/channels",JSONObject().put("title",p.getString("name")));val cid=id("conversation",v.getString("id"));val avatar=Regex("^pulse-media:([0-9a-f-]{36})$").matchEntire(p.optString("avatar_url"))?.groupValues?.get(1);if(avatar!=null)put("/groups/${wire("conversation",cid)}/avatar",JSONObject().put("media_id",avatar));info(cid).put("invite_code",v.optString("invite_code"))}
            "/conversations/groups/join"->{val v=if(p.has("group_number"))post("/groups/join-by-number",JSONObject().put("number",p.get("group_number").toString()).put("invite_code",p.optString("invite_code")))else if(p.has("conversation_id")){val value=p.get("conversation_id").toString();val idValue=value.toIntOrNull();post("/groups/join-by-number",JSONObject().put("number",if(idValue!=null)runCatching{wire("conversation",idValue)}.getOrDefault(value) else value).put("invite_code",p.optString("invite_code")))}else post("/groups/join",JSONObject().put("invite_code",p.getString("invite_code")));JSONObject().put("conversation_id",id("conversation",v.getString("id"))).put("status","joined")}
            "/conversations/channels/follow"->{val rawID=p.optString("invite_code").ifBlank{p.opt("conversation_id")?.toString().orEmpty()};val payload=JSONObject();if(p.optString("invite_code").isNotBlank())payload.put("invite_code",p.getString("invite_code"))else{val local=p.optInt("conversation_id");payload.put("conversation_id",if(local>0)runCatching{wire("conversation",local)}.getOrDefault(rawID) else rawID)};val result=post("/channels/follow",payload);JSONObject().put("conversation_id",id("conversation",result.getString("id"))).put("status","joined")}
            "/conversations/groups/settings"->{if(p.has("all_muted"))put("/groups/${cw()}/mute-all",JSONObject().put("muted",p.getBoolean("all_muted")));val current=info(cid());val patch=JSONObject().put("expected_version",current.getString("preference_version"));if(p.has("notifications_muted"))patch.put("muted_notifications",p.getBoolean("notifications_muted"));if(p.has("is_pinned"))patch.put("pinned",p.getBoolean("is_pinned"));if(patch.length()>1)http("/conversations/${cw()}/preferences","PATCH",patch);val updated=group(cid());val state=info(cid());updated.put("notifications_muted",state.optBoolean("notifications_muted")).put("is_pinned",state.optBoolean("is_pinned"))}
            "/conversations/groups/profile"->if(method=="GET")group(cid())else{
                val patch=JSONObject();if(p.has("name"))patch.put("title",p.getString("name"));if(p.has("description"))patch.put("description",p.getString("description"));if(p.has("announcement"))patch.put("announcement",p.getString("announcement"))
                if(p.has("allow_member_add_friend"))patch.put("block_member_friend_requests",!p.getBoolean("allow_member_add_friend"));if(patch.length()>0)http("/groups/${cw()}","PATCH",patch)
                Regex("^pulse-media:([0-9a-f-]{36})$").matchEntire(p.optString("avatar_url"))?.groupValues?.get(1)?.let{put("/groups/${cw()}/avatar",JSONObject().put("media_id",it))};group(cid())
            }
            "/conversations/groups/mention-members"->{val conversation=wire("conversation",cid());val details=get("/groups/$conversation");val manager=details.optString("my_role") in listOf("owner","admin");val values=all("/groups/$conversation/search-members?q=${enc(q["q"].orEmpty())}");val users=map(values){row->user(row).put("role",row.optString("role"))};page(users,q).put("conversation_id",cid()).put("can_search",manager).put("can_mention_all",manager)}
            "/conversations/members"->if(method=="GET")JSONObject().put("conversation_id",cid()).put("items",map(all("/groups/${cw()}/member-profiles")){v->user(v).put("user_id",id("user",v.getString("id"))).put("muted_until",v.optString("muted_until").takeIf{it.isNotBlank()}?:if(v.optBoolean("muted_permanent"))"9999-12-31 23:59:59" else JSONObject.NULL).put("muted_permanent",v.optBoolean("muted_permanent")).put("is_muted",v.optBoolean("muted"))})else{
                require(p.has("allow_history")){"请选择是否允许查看历史消息"}
                post("/groups/${cw()}/members",JSONObject().put("target_id",wire("user",p.getInt("user_id"))).put("allow_history",p.getBoolean("allow_history")))
                JSONObject().put("conversation_id",cid()).put("user_id",p.getInt("user_id")).put("status","joined")
            }
            "/conversations/members/remove"->mutation("/groups/${cw()}/members/${wire("user",p.getInt("user_id"))}","DELETE")
            "/conversations/members/role"->mutation("/groups/${cw()}/members/${wire("user",p.getInt("user_id"))}/role","PUT",JSONObject().put("role",p.getString("role")))
            "/conversations/members/mute"->{val minutes=p.getInt("minutes");require(minutes in listOf(-1,0)){"仅支持永久禁言或解除"};http("/groups/${cw()}/members/${wire("user",p.getInt("user_id"))}/muted","PUT",JSONObject().put("muted",minutes==-1));val member=all("/groups/${cw()}/member-profiles").let{rows->(0 until rows.length()).map{rows.getJSONObject(it)}.firstOrNull{id("user",it.getString("id"))==p.getInt("user_id")}};JSONObject().put("status","ok").put("conversation_id",cid()).put("user_id",p.getInt("user_id")).put("muted_until",member?.optString("muted_until")?.takeIf{it.isNotBlank()}?:JSONObject.NULL).put("muted_permanent",member?.optBoolean("muted_permanent")?:false).put("is_muted",member?.optBoolean("muted")?:false)}
            "/conversations/groups/transfer"->mutation("/groups/${cw()}/transfer",body=JSONObject().put("target_id",wire("user",p.getInt("user_id"))))
            "/conversations/groups/dissolve"->mutation("/groups/${cw()}","DELETE")
            "/conversations/leave"->mutation("/groups/${cw()}/members/${wire("user",currentUser())}","DELETE")
            "/blocks"->if(method=="GET")all("/blocks").let { values->page(JSONArray((0 until values.length()).map{index->JSONObject().put("user_id",id("user",values.getString(index))).put("blocked_id",id("user",values.getString(index))).put("nickname","已屏蔽用户")}),q) }else mutation("/blocks/${wire("user",p.getInt("user_id"))}","PUT",JSONObject().put("reason",p.optString("reason")))
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
                    else->throw ClientApiException(400,"invalid_request","联系人筛选类型无效")
                }
                page(JSONArray(candidates.values.filter{query.isBlank()||it.optString("nickname").contains(query,true)||it.optString("username").contains(query,true)}),q)
            }
            "/blocks/unblock"->mutation("/blocks/${wire("user",p.getInt("user_id"))}","DELETE")
            "/messages/search"->{
                val pageNumber=(q["page"]?:"1").toInt();val size=(q["size"]?:"20").toInt()
                require(pageNumber in 1..100&&size in 1..100){"搜索分页无效"}
                var path="/messages/search?q=${enc(q["q"].orEmpty())}&limit=$size"
                if((q["conversation_id"]?.toIntOrNull()?:0)>0)path+="&conversation_id=${cw()}"
                if((q["sender_id"]?.toIntOrNull()?:0)>0)path+="&sender_id=${wire("user",q.getValue("sender_id").toInt())}"
                q["type"]?.takeIf{it.isNotBlank()}?.let{path+="&kind=${enc(when(it){"voice"->"audio";"contact_card"->"contact";else->it})}"}
                q["date"]?.takeIf{it.isNotBlank()}?.let{date->
                    val start=java.time.LocalDate.parse(date).atStartOfDay(java.time.ZoneId.of("Asia/Shanghai"))
                    path+="&from=${enc(start.toOffsetDateTime().toString())}&to=${enc(start.plusDays(1).toOffsetDateTime().toString())}"
                }
                var result=JSONObject().put("items",JSONArray());var before=""
                for(index in 1..pageNumber){
                    result=get(path+(if(before.isBlank())"" else "&before_id=$before"))
                    if(index==pageNumber)break
                    before=result.optString("next_before")
                    if(before.isBlank()){result=JSONObject().put("items",JSONArray());break}
                }
                val items=result.getJSONArray("items");val more=result.optString("next_before").isNotBlank()
                result.put("items",messages(items)).put("page",pageNumber).put("size",size).put("has_more",more)
                    .put("total",(pageNumber-1)*size+items.length()+if(more)1 else 0)
            }
            "/messages/shared"->{
                val pageNumber=(q["page"]?:"1").toInt();val size=(q["size"]?:"30").toInt()
                require(pageNumber in 1..100&&size in 1..50){"媒体分页无效"}
                var before="0";var result=JSONObject().put("items",JSONArray())
                for(index in 1..pageNumber){
                    result=get("/conversations/${cw()}/shared-media?kind=${enc(q["type"]?:"all")}&limit=$size&before_seq=$before")
                    if(index==pageNumber)break
                    if(!result.optBoolean("has_more")){result=JSONObject().put("items",JSONArray());break}
                    before=result.getString("next_before_seq")
                }
                val items=result.getJSONArray("items");val more=result.optBoolean("has_more");val state=info(cid())
                result.put("items",messages(items)).put("conversation_id",cid()).put("cleared_before_message_id",state.getInt("cleared_before_message_id"))
                    .put("page",pageNumber).put("size",size).put("total",(pageNumber-1)*size+items.length()+if(more)1 else 0)
            }
            "/messages/locate"->{
                val ref=GoV2Ids.message(base,cid(),input("message_id"));val target=get("/conversations/${cw()}/messages/${ref.first}");val seq=num(target.getString("seq"))
                val older=get("/conversations/${cw()}/history?before_seq=$seq&limit=25").getJSONArray("items")
                val newer=get("/conversations/${cw()}/history?after_seq=$seq&order=asc&limit=25").getJSONArray("items")
                val items=JSONArray();for(index in 0 until older.length())items.put(older.getJSONObject(index));items.put(target);for(index in 0 until newer.length())items.put(newer.getJSONObject(index))
                JSONObject().put("conversation_id",cid()).put("target_id",seq).put("items",messages(items))
            }
            "/messages/pins"->pins(cid())
            "/messages/pin","/messages/unpin"->{
                val ref=GoV2Ids.message(base,cid(),p.getInt("message_id"))
                http("/conversations/${cw()}/pins/${ref.first}",if(route=="/messages/pin")"PUT" else "DELETE",null);pins(cid())
            }
            "/messages"->{
                val type=p.getString("type");require(type in listOf("text","image","video","voice","file","contact_card","shake")){"消息类型无效"}
                val body=p.getJSONObject("body");val send=JSONObject().put("request_id",p.getString("request_id"))
                if(body.has("_source_wire_id"))send.put("source_message_id",body.getString("_source_wire_id"))
                else{
                    val kind=when(type){"voice"->"audio";"contact_card"->"contact";else->type}
                    send.put("kind",kind).put("body",body.optString("text"))
                    if(kind in listOf("image","video","audio","file")){
                        val media=Regex("^pulse-media:([0-9a-f-]{36})$").matchEntire(body.optString("url"))?.groupValues?.get(1)
                            ?:throw ClientApiException(400,"invalid_request","媒体上传尚未完成")
                        send.put("media_id",media)
                    }
                    if(kind=="contact")send.put("card_user_id",wire("user",body.getInt("user_id")))
                    if(body.optInt("reply_to_id")>0)send.put("reply_to_id",GoV2Ids.message(base,cid(),body.getInt("reply_to_id")).first)
                    if(body.optBoolean("mention_all"))send.put("mention_all",true)
                    body.optJSONArray("mention_user_ids")?.let{mentions->send.put("mentions",JSONArray((0 until mentions.length()).map{wire("user",mentions.getInt(it))}))}
                }
                message(post("/conversations/${cw()}/messages",send).getJSONObject("message"))
            }
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
                val rendered=messages(v.getJSONArray("items"))
                GoV2Ids.requireMembership(base,uid,cid(),v.getString("membership_version"))
                JSONObject().put("items",rendered).put("has_more",v.getBoolean("has_more"))
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
