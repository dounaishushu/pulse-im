package com.pulseim.android

import org.json.JSONArray
import okhttp3.OkHttpClient
import okhttp3.ConnectionPool
import okhttp3.Request
import okhttp3.MultipartBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import java.net.URLEncoder
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.UUID

internal class ClientApiException(val status: Int, val errorCode: String, message: String) : IllegalStateException(message) {
    val authenticationRejected: Boolean get() = status == 401 || (status == 400 && message in listOf("请先登录。", "登录状态已过期，请重新登录。", "用户账号不可用。"))
}

class ApiClient(private val baseUrl: String) {
    private val credentials = java.util.concurrent.atomic.AtomicReference<Pair<String?, Long>>(null to 0L)
    companion object {
        // Mutation replay is decided explicitly by request_id, never by the HTTP stack.
        private val transport = OkHttpClient.Builder().retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).writeTimeout(20, TimeUnit.SECONDS).build()
        // A closed idle connection is not a failed route; reconnect reads on that same origin first.
        private val readTransport = transport.newBuilder().retryOnConnectionFailure(true).build()
    }

    init { require(ClientPolicy.secureEndpoint(baseUrl)) { "服务器地址无效，正式版本必须使用 HTTPS" } }
    var token: String?
        get() = credentials.get().first
        set(value) { credentials.updateAndGet { prior -> if (prior.first == value) prior else value to (prior.second + 1) } }
    internal var requestScope: ApiRequestScope? = null

    fun login(phone: String, password: String, twoStepCode: String = ""): String = request("/auth/login", "POST", JSONObject().apply {
        put("phone", phone); put("password", password); put("device_type", "android"); put("two_step_code", twoStepCode)
        put("device_id", MobileDeviceIdentity.id()); put("device_name", MobileDeviceIdentity.name())
    }).getJSONObject("data").getString("access_token")

    fun registerChallenge(): JSONObject = request("/auth/register-challenge?format=digits4", "GET").getJSONObject("data")

    fun register(username: String, password: String, nickname: String, captchaId: String, captchaCode: String, avatarUrl: String = "", avatarDataURL: String = ""): JSONObject = request("/auth/register", "POST", JSONObject().apply {
        put("device_id", MobileDeviceIdentity.id()); put("device_name", MobileDeviceIdentity.name())
        if (avatarDataURL.isNotEmpty()) { put("registration_form", "single_page_v1"); put("avatar_data_url", avatarDataURL) }; put("username", username); put("password", password); put("nickname", nickname); put("device_type", "android"); put("captcha_id", captchaId); put("captcha_code", captchaCode); if (avatarUrl.isNotBlank()) put("avatar_url", avatarUrl)
    }).getJSONObject("data")

    fun me(): JSONObject = request("/auth/me", "GET").getJSONObject("data")
    fun userByPublicId(publicId: String): JSONObject {
        require(PublicUserId.value(publicId) != null) { "用户 ID 无效" }
        val page = request("/contacts/search?public_id=${URLEncoder.encode(publicId, "UTF-8")}", "GET").getJSONObject("data")
        val items = page.optJSONArray("items")
        check(items != null && page.opt("total") == 1 && page.opt("page") == 1 &&
            page.opt("size") == 1 && items.length() == 1) { "未找到唯一匹配的用户" }
        val user = items.optJSONObject(0)
        check(user != null && (user.opt("id") as? Int)?.let { it > 0 } == true && PublicUserId.value(user.opt("public_id")) == publicId) { "用户 ID 查询结果不匹配" }
        return user
    }
    fun updateProfile(patch: JSONObject): JSONObject = request("/auth/profile", "POST", patch).getJSONObject("data")
    fun userSettings(): JSONObject = request("/auth/settings", "GET").getJSONObject("data")
    fun updateUserSettings(patch: JSONObject): JSONObject = request("/auth/settings", "POST", patch).getJSONObject("data")
    fun security(): JSONObject = request("/auth/security", "GET").getJSONObject("data")
    fun updateSecurity(patch: JSONObject): JSONObject = request("/auth/security", "POST", patch).getJSONObject("data")
    fun blocksPage(page: Int): JSONObject = request("/blocks?page=$page&size=50", "GET").getJSONObject("data")
    fun blockUser(id: Int): JSONObject = request("/blocks", "POST", JSONObject().put("user_id", id)).getJSONObject("data")
    fun blockCandidates(kind: String, query: String, page: Int): JSONObject = request("/blocks/candidates?kind=$kind&q=${URLEncoder.encode(query, "UTF-8")}&page=$page&size=50", "GET").getJSONObject("data")
    fun logout(): JSONObject = request("/auth/logout", "POST", JSONObject()).getJSONObject("data")
    fun uploadDiagnostics(payload: JSONObject): JSONObject {
        if(BuildConfig.GO_BACKEND){
            val result=goRequest("/client/diagnostics","POST",JSONObject().put("platform","android").put("version",BuildConfig.VERSION_NAME).put("report",payload))
            return JSONObject().put("report_id",result.getString("id"))
        }
        val body = payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder().url(RouteManager.api(baseUrl) + "/client/diagnostics").post(body)
            .header("Authorization", "Bearer ${token.orEmpty()}").header("Accept", "application/json").build()
        // Diagnostics never occupy chat executors or trigger global route probes/replays.
        return transport.newBuilder().callTimeout(10, TimeUnit.SECONDS).build().newCall(request).execute().use {
            readResponse(it.code, it.body?.string().orEmpty()).getJSONObject("data")
        }
    }
    fun registerNotificationDevice(deviceToken: String): JSONObject = request("/notifications/devices/register", "POST", JSONObject().apply { put("platform", "android"); put("device_token", deviceToken) }).getJSONObject("data")
    fun unregisterNotificationDevice(deviceToken: String): JSONObject = request("/notifications/devices/unregister", "POST", JSONObject().put("device_token", deviceToken)).getJSONObject("data")
    fun notificationDevices(): JSONArray = request("/notifications/devices", "GET").getJSONObject("data").getJSONArray("items")
    fun updateProfile(nickname: String, avatarUrl: String): JSONObject = request("/auth/profile", "POST", JSONObject().apply { put("nickname", nickname); put("avatar_url", avatarUrl) }).getJSONObject("data")
    fun changePassword(currentPassword: String, newPassword: String): JSONObject = request("/auth/password", "POST", JSONObject().apply { put("current_password", currentPassword); put("new_password", newPassword) }).getJSONObject("data")
    fun sessions(): JSONArray = request("/auth/sessions", "GET").getJSONObject("data").getJSONArray("items")
    fun revokeSession(sessionId: Int): JSONObject = request("/auth/sessions/revoke", "POST", JSONObject().put("session_id", sessionId)).getJSONObject("data")
    fun blocks(): JSONArray = request("/blocks?page=1&size=50", "GET").getJSONObject("data").getJSONArray("items")
    fun unblock(userId: Int): JSONObject = request("/blocks/unblock", "POST", JSONObject().put("user_id", userId)).getJSONObject("data")
    fun conversations(): JSONArray = request("/conversations", "GET").getJSONObject("data").getJSONArray("items")
    fun hideConversation(conversationId: Int): JSONObject = request("/conversations/hide", "POST", JSONObject().put("conversation_id", conversationId)).getJSONObject("data")
    fun openConversation(conversationId: Int): JSONObject = request("/conversations/open", "POST", JSONObject().put("conversation_id", conversationId)).getJSONObject("data")
    fun favoritesConversation(): JSONObject = request("/conversations/favorites", "POST", JSONObject()).getJSONObject("data")
    fun sendRawMessage(conversationId: Int, type: String, body: JSONObject, requestId: String): JSONObject = request("/messages", "POST", JSONObject().apply {
        put("conversation_id", conversationId); put("type", type); put("body", JSONObject(body.toString())); put("request_id", requestId)
    }).getJSONObject("data")
    fun updateConversationSettings(conversationId: Int, notificationsMuted: Boolean? = null, isPinned: Boolean? = null): JSONObject = request("/conversations/settings", "POST", JSONObject().apply {
        put("conversation_id", conversationId)
        if (notificationsMuted != null) put("notifications_muted", notificationsMuted)
        if (isPinned != null) put("is_pinned", isPinned)
    }).getJSONObject("data")
    fun conversationInfo(conversationId: Int): JSONObject = request("/conversations/info?conversation_id=$conversationId", "GET").getJSONObject("data")
    fun subscriptionIds(after: Int): JSONObject = request("/conversations/subscriptions?after=$after", "GET").getJSONObject("data")
    fun conversationsPage(type: String, page: Int): JSONObject = request("/conversations?type=$type&page=$page&size=50", "GET").getJSONObject("data")
    fun createDirectConversation(userId: Int): JSONObject = request("/conversations/direct", "POST", JSONObject().put("user_id", userId)).getJSONObject("data")
    fun createGroup(name: String, memberIds: JSONArray = JSONArray(), allowMemberAddFriend: Boolean = true, avatarUrl: String = ""): JSONObject = request("/conversations/groups", "POST", JSONObject().apply { put("name", name); put("member_ids", memberIds); put("allow_member_add_friend", allowMemberAddFriend); put("avatar_url", avatarUrl) }).getJSONObject("data")
    fun chatPage(page: Int): JSONObject = request("/conversations?page=$page&size=50", "GET").getJSONObject("data")
    internal fun navigationBadgeSnapshot(stillCurrent: () -> Boolean): NavigationBadgeSnapshot {
        val conversations = linkedMapOf<Int, Int>()
        val latestMessageIds = linkedMapOf<Int, Int>()
        val requests = mutableSetOf<Int>()
        fun pages(route: String, consume: (JSONObject) -> Unit) {
            var page = 1
            do {
                check(stillCurrent()) { "Badge account changed" }
                val separator = if (route.contains('?')) "&" else "?"
                val result = request("$route${separator}page=$page&size=100", "GET").getJSONObject("data")
                check(stillCurrent()) { "Badge account changed" }
                val rows = result.getJSONArray("items")
                val size = result.getInt("size")
                val total = result.getInt("total")
                check(size > 0 && total >= 0 && result.getInt("page") == page) { "Invalid badge page" }
                for (i in 0 until rows.length()) consume(rows.getJSONObject(i))
                val hasMore = page.toLong() * size < total
                check(!hasMore || rows.length() > 0) { "Incomplete badge page" }
                page++
            } while (hasMore)
        }
        pages("/conversations") { item ->
            val id = item.getInt("id")
            latestMessageIds[id] = item.optJSONObject("last_message")?.optInt("id") ?: 0
            conversations[id] = if (item.optBoolean("notifications_muted")) 0 else item.optInt("unread_count").coerceAtLeast(0)
        }
        pages("/contact-requests?direction=received") { item ->
            val id = item.getInt("id")
            if (item.optString("status") == "pending") requests.add(id) else requests.remove(id)
        }
        return NavigationBadgeSnapshot(conversations, requests, latestMessageIds)
    }
    fun clientConfig(): JSONObject = request("/client/config", "GET").getJSONObject("data")
    fun clientRoutes(): JSONArray = request("/client/routes", "GET").getJSONObject("data").getJSONArray("items")
    fun workTasks(): JSONObject = request("/work-tasks", "GET").getJSONObject("data")
    fun startWorkTask(taskId: Int, verificationCode: String): JSONObject = request("/work-tasks/start", "POST", JSONObject().apply { put("task_id", taskId); put("verification_code", verificationCode) }).getJSONObject("data")
    fun workTaskRecord(recordId: Int): JSONObject {
        val result = request("/work-tasks/record?id=$recordId", "GET").getJSONObject("data")
        check(result.getJSONObject("record").getInt("id") == recordId &&
            (result.getJSONObject("record").optString("status") == "in_progress" || WorkTaskSettlement.complete(result))) { "未能取得完整结算结果，请重试" }
        return result
    }
    fun submitWorkTask(recordId: Int, answers: JSONObject): JSONObject {
        val result = request("/work-tasks/submit", "POST", JSONObject().apply { put("record_id", recordId); put("answers", answers) }).getJSONObject("data")
        check(result.getJSONObject("record").getInt("id") == recordId && WorkTaskSettlement.complete(result)) { "未能取得完整结算结果，请重试提交" }
        return result
    }
    fun saveWorkTaskAnswers(recordId: Int, answers: JSONObject): JSONObject = request("/work-tasks/answers", "POST", JSONObject().apply { put("record_id", recordId); put("answers", answers) }).getJSONObject("data")
    fun searchMessages(keyword: String, page: Int = 1, conversationId: Int = 0): JSONObject = request("/messages/search?q=${URLEncoder.encode(keyword, "UTF-8")}&conversation_id=$conversationId&page=$page&size=20", "GET").getJSONObject("data")
    fun joinGroup(inviteCode: String): JSONObject = request("/conversations/groups/join", "POST", JSONObject().put("invite_code", inviteCode)).getJSONObject("data")
    fun requestJoinGroup(conversationId: Int): JSONObject = request("/conversations/groups/join", "POST", JSONObject().put(if(BuildConfig.GO_BACKEND)"group_number" else "conversation_id", conversationId)).getJSONObject("data")
    fun legacyQrProfile(userId:Int):JSONObject=request("/contacts/legacy-profile?legacy_user_id=$userId","GET").getJSONObject("data")
    fun createChannel(name: String): JSONObject = request("/conversations/channels", "POST", JSONObject().put("name", name)).getJSONObject("data")
    fun followChannel(conversationId: Int = 0, inviteCode: String = ""): JSONObject = request("/conversations/channels/follow", "POST", JSONObject().put("conversation_id", conversationId).put("invite_code", inviteCode)).getJSONObject("data")
    fun conversationMembers(conversationId: Int): JSONArray = request("/conversations/members?conversation_id=$conversationId", "GET").getJSONObject("data").getJSONArray("items")
    fun groupMentionMembers(conversationId: Int, query: String, page: Int = 1): JSONObject = request("/conversations/groups/mention-members?conversation_id=$conversationId&q=${URLEncoder.encode(query, "UTF-8")}&page=$page", "GET").getJSONObject("data")
    fun groupProfile(conversationId: Int): JSONObject = request("/conversations/groups/profile?conversation_id=$conversationId", "GET").getJSONObject("data")
    fun updateGroupProfile(conversationId: Int, name: String, description: String = "", announcement: String = "", avatarUrl: String? = null, allowMemberAddFriend: Boolean? = null): JSONObject = request("/conversations/groups/profile", "POST", JSONObject().apply { put("conversation_id", conversationId); put("name", name); put("description", description); put("announcement", announcement); if (avatarUrl != null) put("avatar_url", avatarUrl); if (allowMemberAddFriend != null) put("allow_member_add_friend", allowMemberAddFriend) }).getJSONObject("data")
    fun addConversationMember(conversationId: Int, userId: Int, allowHistory: Boolean = false): JSONObject = request("/conversations/members", "POST", JSONObject().apply { put("conversation_id", conversationId); put("user_id", userId); if(BuildConfig.GO_BACKEND) put("allow_history",allowHistory) }).getJSONObject("data")
    fun removeConversationMember(conversationId: Int, userId: Int): JSONObject = request("/conversations/members/remove", "POST", JSONObject().apply { put("conversation_id", conversationId); put("user_id", userId) }).getJSONObject("data")
    fun setConversationRole(conversationId: Int, userId: Int, role: String): JSONObject = request("/conversations/members/role", "POST", JSONObject().apply { put("conversation_id", conversationId); put("user_id", userId); put("role", role) }).getJSONObject("data")
    fun muteConversationMember(conversationId: Int, userId: Int, minutes: Int): JSONObject = request("/conversations/members/mute", "POST", JSONObject().apply { put("conversation_id", conversationId); put("user_id", userId); put("minutes", minutes) }).getJSONObject("data")
    fun transferGroup(conversationId: Int, userId: Int): JSONObject = request("/conversations/groups/transfer", "POST", JSONObject().apply { put("conversation_id", conversationId); put("user_id", userId) }).getJSONObject("data")
    fun dissolveGroup(conversationId: Int): JSONObject = request("/conversations/groups/dissolve", "POST", JSONObject().put("conversation_id", conversationId)).getJSONObject("data")
    fun updateGroupSettings(conversationId: Int, notificationsMuted: Boolean? = null, isPinned: Boolean? = null): JSONObject = request("/conversations/groups/settings", "POST", JSONObject().apply { put("conversation_id", conversationId); if (notificationsMuted != null) put("notifications_muted", notificationsMuted); if (isPinned != null) put("is_pinned", isPinned) }).getJSONObject("data")
    fun leaveConversation(conversationId: Int): JSONObject = request("/conversations/leave", "POST", JSONObject().put("conversation_id", conversationId)).getJSONObject("data")
    fun contacts(): JSONArray = request(if(BuildConfig.GO_BACKEND) "/contacts?all=true" else "/contacts", "GET").getJSONObject("data").getJSONArray("items")
    fun contactsPage(page: Int): JSONObject = request("/contacts?page=$page&size=50", "GET").getJSONObject("data")
    fun searchUsersPage(keyword: String, page: Int): JSONObject {
        val username = keyword.trim()
        val result = request("/contacts/search?q=${URLEncoder.encode(username, "UTF-8")}&page=$page&size=20", "GET").getJSONObject("data")
        val rows = result.getJSONArray("items")
        val matches = (0 until rows.length()).map { rows.getJSONObject(it) }
            .filter { username.isNotEmpty() && it.optString("username").equals(username, ignoreCase = true) }
        // Older servers can still return nickname matches. Never display those
        // identities or their aggregate counts in an exact account search.
        return JSONObject().put("items", JSONArray(if (matches.size == 1) matches else emptyList<JSONObject>()))
            .put("total", if (matches.size == 1) 1 else 0).put("page", page).put("size", 20)
    }
    fun friendRequestsPage(page: Int): JSONObject = request("/contact-requests?direction=received&page=$page&size=20", "GET").getJSONObject("data")
    fun searchUsers(keyword: String): JSONArray = searchUsersPage(keyword, 1).getJSONArray("items")
    fun sendFriendRequest(userId: Int, message: String = "请求添加您为好友", contextConversationId: Int? = null, cardConversationId: Int? = null, cardMessageId: Int? = null): JSONObject = request("/contact-requests", "POST", JSONObject().apply {
        put("to_user_id", userId); put("message", message)
        if (contextConversationId != null) { require(contextConversationId > 0); put("context_conversation_id", contextConversationId) }
        if (cardConversationId != null || cardMessageId != null) {
            require(cardConversationId != null && cardConversationId > 0 && cardMessageId != null && cardMessageId > 0)
            put("card_conversation_id", cardConversationId); put("card_message_id", cardMessageId)
        }
    }).getJSONObject("data")
    fun forceAddContact(userId: Int): JSONObject = request("/contacts/force-add", "POST", JSONObject().put("user_id", userId)).getJSONObject("data")
    fun friendRequests(): JSONArray = request("/contact-requests?direction=received", "GET").getJSONObject("data").getJSONArray("items")
    fun friendChats(afterId: Long): JSONArray = request("/notifications/friend-chats?after_id=${maxOf(0L, afterId)}", "GET").getJSONObject("data").getJSONArray("items")
    fun handleFriendRequest(requestId: Int, action: String): JSONObject = request("/contact-requests/handle", "POST", JSONObject().apply { put("request_id", requestId); put("action", action) }).getJSONObject("data")
    fun uploadMedia(file: File, kind: String, mime: String, original: Boolean = false, onCall: ((okhttp3.Call) -> Unit)? = null): JSONObject {
        require(!original || kind == "image") { "原图只适用于聊天图片" }
        if(BuildConfig.GO_BACKEND) return uploadGoMedia(file,kind,original,onCall)
        require(file.isFile && file.length() > 0) { "所选文件为空或已不可读取，请重新选择" }
        require(kind in listOf("image", "video", "file", "voice")) { "不支持此上传类型" }
        val safeName = file.name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val safeMime = mime.takeIf { it.matches(Regex("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) } ?: "application/octet-stream"
        val failedBase = RouteManager.api(baseUrl)
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("kind", kind).addFormDataPart("file", safeName, file.asRequestBody(safeMime.toMediaType())).build()
        val request = Request.Builder().url(failedBase + "/uploads").post(body)
            .header("X-Client-Platform", "android").header("X-Client-Version", BuildConfig.VERSION_NAME)
            .header("Authorization", "Bearer ${token ?: ""}").header("Accept", "application/json").build()
        // newBuilder() otherwise shares the ordinary API pool. Uploads must not
        // inherit a stale keep-alive (or a failing multiplexed connection): their
        // result is uncertain after a disconnect, so replay remains disabled.
        // A pool per call also isolates parallel photos and closes idle sockets.
        val call = transport.newBuilder().connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
            .readTimeout(60, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).build().newCall(request)
        try {
            onCall?.invoke(call)
            call.execute().use { response ->
                if (response.code in listOf(502, 503, 504)) {
                    throw ClientApiException(response.code, "UPLOAD_HTTP_${response.code}", "${httpError(response.code)}（HTTP ${response.code}）")
                }
                return readResponse(response.code, response.body?.string().orEmpty()).getJSONObject("data")
            }
        } catch (error: ClientApiException) {
            if (call.isCanceled()) throw java.util.concurrent.CancellationException("上传已停止")
            if (error.status in listOf(502, 503, 504) && RouteManager.failover(baseUrl, failedBase)) {
                throw ClientApiException(error.status, error.errorCode, "${error.message}；已切换备用线路，请重新上传")
            }
            throw error
        } catch (error: java.io.IOException) {
            if (call.isCanceled()) throw java.util.concurrent.CancellationException("上传已停止")
            val switched = RouteManager.failover(baseUrl, failedBase)
            val reason = when (error) {
                is java.net.SocketTimeoutException -> "上传或等待服务器响应超时，请检查网络后重试"
                is java.net.UnknownHostException -> "无法解析上传服务器地址，请检查网络后重试"
                is javax.net.ssl.SSLException -> "无法建立安全上传连接，请检查网络或稍后重试"
                is java.net.ConnectException -> "无法连接上传服务器，请检查网络后重试"
                else -> "上传连接中断，请重试"
            }
            throw IllegalStateException(reason + if (switched) "；已切换备用线路" else "", error)
        }
    }
    private fun uploadGoMedia(file: File, kind: String, original: Boolean, onCall: ((okhttp3.Call) -> Unit)?): JSONObject {
        val captured=credentials.get()
        fun requireSession() { if(credentials.get()!=captured)throw ClientApiException(409,"stale_session","账号已改变，本次上传已取消");requestScope?.checkActive() }
        requireSession()
        require(file.isFile && file.length()>0){"所选文件为空或已不可读取"}
        val mediaKind=if(kind=="voice")"audio" else kind
        require(mediaKind in listOf("image","video","audio","file")){"不支持此上传类型"}
        val maximum=(when(mediaKind){"video"->100L;"file"->50L;else->10L})*1024*1024
        if(file.length()>maximum)throw ClientApiException(413,"media_too_large","文件超过该类型允许的大小，请选择较小文件")
        val digest=MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use{stream->val buffer=ByteArray(64*1024);while(true){requireSession();val count=stream.read(buffer);if(count<0)break;digest.update(buffer,0,count)}}
        val checksum=digest.digest().joinToString(""){byte->"%02x".format(byte.toInt() and 255)}
        val requestId="android-media-${UUID.randomUUID()}"
        val safeName=file.name.replace(Regex("[\\\\/:\\r\\n]"),"_")
        val payload=JSONObject().put("request_id",requestId).put("kind",mediaKind).put("filename",safeName)
            .put("bytes",file.length().toString()).put("sha256",checksum).put("original",original)
        var admitted:JSONObject?=null
        repeat(12){attempt->
            if(admitted==null)try{admitted=goRequest("/media/uploads","POST",payload,captured.second)}
            catch(error:ClientApiException){if(error.status !in listOf(429,503))throw error;Thread.sleep(minOf(3000L,500L*(attempt+1)))}
        }
        val media=admitted?:throw ClientApiException(503,"upload_busy","上传队列繁忙，请稍后重试")
        requireSession()
        val mediaId=media.getString("id")
        if(media.optString("status")=="pending"){
            val request=Request.Builder().url(RouteManager.api(baseUrl)+"/media/$mediaId/bytes").put(file.asRequestBody("application/octet-stream".toMediaType()))
                .header("Authorization","Bearer ${captured.first.orEmpty()}").header("Accept","application/json").build()
            val call=transport.newBuilder().readTimeout(150,TimeUnit.SECONDS).writeTimeout(150,TimeUnit.SECONDS).build().newCall(request)
            requestScope?.track(call)
            try{onCall?.invoke(call);requireSession();call.execute().use{response->
                val raw=response.body?.string().orEmpty();if(!response.isSuccessful){
                    val code=runCatching{JSONObject(raw).optJSONObject("error")?.optString("code")}.getOrNull().orEmpty()
                    throw ClientApiException(response.code,code,"上传失败（HTTP ${response.code}）")
                }
            }}finally{requestScope?.release(call)}
        }
        repeat(90){
            requireSession()
            val result=goRequest("/media/$mediaId","GET",null,captured.second)
            when(result.optString("status")){
                "ready"->{
                    if(original && !result.optBoolean("original"))throw ClientApiException(409,"original_not_preserved","服务器未保留原图，本次发送已停止")
                    return JSONObject().put("id",mediaId).put("url","pulse-media:$mediaId").put("mime",result.optString("mime"))
                    .put("size",result.optLong("bytes")).put("width",result.optInt("width")).put("height",result.optInt("height"))
                    .put("duration_ms",result.optLong("duration_ms")).put("original",result.optBoolean("original"))
                }
                "failed","cancelled"->throw ClientApiException(422,result.optString("error_code"),"图片或文件处理失败")
            }
            Thread.sleep(1000)
        }
        throw ClientApiException(503,"upload_timeout","媒体处理超时，请稍后重试")
    }
    fun sendMediaMessage(conversationId: Int, type: String, upload: JSONObject, requestId: String, replyToId: Int = 0): JSONObject = request("/messages", "POST", JSONObject().apply { put("conversation_id", conversationId); put("type", type); put("body", JSONObject().apply { put("url", upload.getString("url")); put("mime", upload.optString("mime")); put("size", upload.optLong("size")); if (upload.has("name")) put("name", upload.getString("name")); if (replyToId > 0) put("reply_to_id", replyToId) }); put("request_id", requestId) }).getJSONObject("data")
    internal fun historyPage(conversationId: Int, maxId: Int = 0, size: Int = 50): ChatHistoryPage {
        require(conversationId > 0 && maxId >= 0 && size in 1..50)
        val upper = if (maxId > 0) "&max_id=$maxId" else ""
        return ChatHistoryPage.parse(request("/messages/history?conversation_id=$conversationId&page=1&size=$size$upper", "GET").getJSONObject("data"), conversationId, maxId)
    }
    fun history(conversationId: Int): JSONArray = JSONArray().apply { historyPage(conversationId).items.asReversed().forEach { put(it) } }
    fun syncMessages(conversationId: Int, floor: Int, after: Int, maximum: Int?, membershipVersion: String? = null): JSONObject = request("/messages/sync?conversation_id=$conversationId&floor_id=$floor&after_id=$after&limit=100" + (maximum?.let { "&snapshot_max_id=$it" } ?: "") + (membershipVersion?.let { "&membership_version=${URLEncoder.encode(it,"UTF-8")}" } ?: ""), "GET").getJSONObject("data")
    fun sendText(conversationId: Int, text: String, requestId: String, replyToId: Int = 0, mentionUserIds: IntArray = intArrayOf()): JSONObject = request("/messages", "POST", JSONObject().apply {
        put("conversation_id", conversationId); put("type", "text"); put("body", JSONObject().put("text", text).apply { if (replyToId > 0) put("reply_to_id", replyToId); if (mentionUserIds.isNotEmpty()) put("mention_user_ids", JSONArray(mentionUserIds.toList())) }); put("request_id", requestId)
    }).getJSONObject("data")
    fun sendShake(conversationId: Int, requestId: String, replyToId: Int = 0): JSONObject = request("/messages", "POST", JSONObject().apply {
        put("conversation_id", conversationId)
        put("type", "shake")
        put("body", JSONObject().put("text", "窗口抖动").apply { if (replyToId > 0) put("reply_to_id", replyToId) })
        put("request_id", requestId)
    }).getJSONObject("data")
    private fun profileContext(contextConversationId: Int?): String {
        if (contextConversationId == null) return ""
        require(contextConversationId > 0) { "无效的来源群" }
        return "&context_conversation_id=$contextConversationId"
    }
    fun contactProfile(userId: Int, contextConversationId: Int? = null): JSONObject = request("/contacts/profile?user_id=$userId" + profileContext(contextConversationId), "GET").getJSONObject("data")
    fun receivedContactCardUser(message: JSONObject): JSONObject {
        val userId = message.optJSONObject("body")?.optInt("user_id") ?: 0
        val conversationId = message.optInt("conversation_id"); val messageId = message.optInt("id")
        require(userId > 0 && conversationId > 0 && messageId > 0 && message.optString("type") == "contact_card") { "名片用户或来源无效" }
        val profile = request("/contacts/card-profile?user_id=$userId&conversation_id=$conversationId&message_id=$messageId", "GET").getJSONObject("data")
        check(profile.optInt("id") == userId && profile.optInt("source_conversation_id") == conversationId && profile.optInt("source_message_id") == messageId
            && profile.opt("is_contact") is Boolean && profile.opt("can_add_friend") is Boolean) { "名片资料响应无效" }
        return profile
    }
    fun updateContactRemark(userId: Int, remark: String, groupName: String): JSONObject = request("/contacts/remark", "POST", JSONObject().put("user_id", userId).put("remark", remark).put("group_name", groupName)).getJSONObject("data")
    fun contactNamePage(page: Int): JSONObject = request("/contacts/names?page=$page&size=100", "GET").getJSONObject("data")
    fun removeContact(userId: Int): JSONObject = request("/contacts/remove", "POST", JSONObject().put("user_id", userId)).getJSONObject("data")
    fun commonContactGroups(userId: Int, page: Int, contextConversationId: Int? = null): JSONObject = request("/contacts/common-groups?user_id=$userId&page=$page&size=20" + profileContext(contextConversationId), "GET").getJSONObject("data")
    fun sharedMedia(conversationId: Int, page: Int): JSONObject = request("/messages/shared?conversation_id=$conversationId&page=$page&size=30&type=all", "GET").getJSONObject("data")
    fun internalProfile(userId: Int, contextConversationId: Int? = null): JSONObject = request("/contacts/internal-profile?user_id=$userId" + profileContext(contextConversationId), "GET").getJSONObject("data")
    fun recallMessage(messageId: Int, conversationId: Int): JSONObject = request("/messages/recall", "POST", JSONObject().put("message_id", messageId).put("conversation_id",conversationId)).getJSONObject("data")
    fun editMessage(messageId: Int, text: String, conversationId: Int, expectedVersion: String? = null): JSONObject = request("/messages/edit", "POST", JSONObject().apply {
        put("message_id", messageId); put("text", text); put("conversation_id",conversationId)
        if(BuildConfig.GO_BACKEND) { require(expectedVersion?.toLongOrNull()?.let{it>0}==true) { "请重新打开消息编辑器" }; put("expected_version",expectedVersion) }
    }).getJSONObject("data")
    fun markMessageRead(messageId: Int): JSONObject = request("/messages/receipt", "POST", JSONObject().apply { put("message_id", messageId); put("status", "read") }).getJSONObject("data")
    fun readConversation(conversationId: Int, throughMessageId: Int): JSONObject = request("/messages/receipt", "POST", JSONObject().apply { put("conversation_id", conversationId); put("through_message_id", throughMessageId); put("status", "read") }).getJSONObject("data")
    fun sendVoice(conversationId: Int, url: String, durationMs: Long, size: Long, requestId: String, replyToId: Int = 0): JSONObject = request("/messages", "POST", JSONObject().apply {
        put("conversation_id", conversationId); put("type", "voice"); put("body", JSONObject().apply { put("url", url); put("duration_ms", durationMs); put("size", size); if (replyToId > 0) put("reply_to_id", replyToId) }); put("request_id", requestId)
    }).getJSONObject("data")

    fun messagePins(conversationId: Int): JSONObject = request("/messages/pins?conversation_id=$conversationId", "GET").getJSONObject("data")
    fun setMessagePin(conversationId: Int, messageId: Int, pinned: Boolean): JSONObject = request(if (pinned) "/messages/pin" else "/messages/unpin", "POST", JSONObject().put("conversation_id", conversationId).put("message_id", messageId)).getJSONObject("data")
    fun locateMessage(conversationId: Int, messageId: Int): JSONObject = request("/messages/locate?conversation_id=$conversationId&message_id=$messageId", "GET").getJSONObject("data")
    internal fun freshImageUrl(conversationId: Int, messageId: Int): String {
        require(conversationId > 0 && messageId > 0)
        val page = locateMessage(conversationId, messageId)
        require(page.getInt("target_id") == messageId) { "图片消息不可用" }
        val rows = page.getJSONArray("items")
        val message = (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optInt("id") == messageId && it.optInt("conversation_id") == conversationId }
        require(message != null && message.optString("type") == "image" && message.isNull("recalled_at") && message.optString("status") !in listOf("recalled", "deleted")) { "图片已撤回、已删除或无权查看" }
        return message.getJSONObject("body").getString("url").also { require(it.isNotBlank() && it != "null") { "图片地址无效" } }
    }
    fun clearHistory(conversationId: Int): JSONObject = request("/messages/clear-history", "POST", JSONObject().put("conversation_id", conversationId)).getJSONObject("data")
    fun deleteMessages(conversationId: Int, messageIds: List<Int>): JSONObject = request("/messages/delete", "POST", JSONObject().put("conversation_id", conversationId).put("message_ids", org.json.JSONArray(messageIds))).getJSONObject("data")

    fun uploadVoice(file: File): JSONObject = JSONObject().put("ok", true).put("data", uploadMedia(file, "voice", "audio/mp4"))

    private val go by lazy { GoV2Api(baseUrl.trimEnd('/'), { token }, { credentials.get().second }, ::goRequest) }
    fun goPrivacy(): JSONObject = request("/go/privacy", "GET").getJSONObject("data")
    fun updateGoPrivacy(value: JSONObject): JSONObject = request("/go/privacy", "PATCH", value).getJSONObject("data")
    fun realtimeTicket(): String = goRequest("/realtime/tickets", "POST", JSONObject()).getString("ticket")
    private fun goRequest(path: String, method: String, payload: JSONObject?, expectedSession: Long = credentials.get().second): JSONObject {
        val captured = credentials.get()
        fun requireSession() { if (credentials.get() != captured || captured.second != expectedSession) throw ClientApiException(409,"stale_session","账号已改变，本次操作已取消") }
        requireSession()
        val scope = requestScope; scope?.checkActive()
        val body = if (method in listOf("GET","HEAD")) null else (payload?.toString() ?: "").toRequestBody("application/json; charset=utf-8".toMediaType())
        val failedBase=RouteManager.api(baseUrl)
        fun perform(endpoint:String):JSONObject {
        requireSession()
        val request = Request.Builder().url(endpoint + path).method(method,body).header("Accept","application/json")
        captured.first?.let { request.header("Authorization","Bearer $it") }
        val call = (if(method=="GET") readTransport else transport).newCall(request.build()); scope?.track(call)
        try { return call.execute().use { response ->
            val text=response.body?.string().orEmpty();scope?.checkActive();requireSession()
            val data=if(text.isBlank() && response.code==204) JSONObject() else try { JSONObject(text) } catch (_: Exception) { throw ClientApiException(response.code,"invalid_response","服务返回格式异常，请稍后重试") }
            if(!response.isSuccessful){
                val code=data.optJSONObject("error")?.optString("code").orEmpty()
                val message=when(code){"unauthorized"->"登录状态已失效，请重新登录";"device_session_limit"->"登录设备已达 8 台，请在已登录设备的“设备会话”中退出不用的设备后重试";"second_factor_required"->"请输入两步验证密码或恢复码";"mobile_device_bound"->"账号已绑定其他手机，请联系管理员解除旧设备绑定";"forbidden"->"当前无操作权限，或对方的隐私设置限制了此操作";"membership_changed"->"群成员权限已变化，请重新打开会话";"request_conflict"->"数据已更新，请刷新后重试";"rate_limited"->"操作过于频繁，请稍后重试";"group_full"->"群人数已达到上限";"not_found"->"未找到对应内容";"invalid_request"->"请求参数不完整，请检查后重试";else->httpError(response.code)}
                throw ClientApiException(response.code,code,message)
            };data
        } } finally { scope?.release(call) }
        }
        try { return perform(failedBase) }
        catch(error:Exception){
            scope?.checkActive()
            val retryable=error is java.io.IOException || error is ClientApiException && error.status in listOf(502,503,504)
            val safe=method in listOf("GET","HEAD") || method=="POST" && Regex("/conversations/[0-9a-f-]{36}/messages").matches(path) && !payload?.optString("request_id").isNullOrBlank()
            if(retryable&&safe&&RouteManager.failover(baseUrl,failedBase))return perform(RouteManager.api(baseUrl))
            throw error
        }
    }
    private fun request(path: String, method: String, payload: JSONObject? = null): JSONObject {
        if (BuildConfig.GO_BACKEND) return go.request(path,method,payload)
        val scope = requestScope
        scope?.checkActive()
        val failedBase = RouteManager.api(baseUrl)
        fun perform(endpoint: String): JSONObject {
            val body = if (method in listOf("GET", "HEAD")) null else (payload?.toString() ?: "").toRequestBody("application/json; charset=utf-8".toMediaType())
            val builder = Request.Builder().url(endpoint + path).method(method, body)
                .header("X-Client-Platform", "android").header("X-Client-Version", BuildConfig.VERSION_NAME)
                .header("Accept", "application/json").header("Accept-Encoding", "identity")
            token?.let { builder.header("Authorization", "Bearer $it") }
            val client = if (method in listOf("GET", "HEAD")) readTransport else transport
            val call = client.newCall(builder.build())
            scope?.track(call)
            try {
                call.execute().use { response ->
                    if (response.code in listOf(502, 503, 504)) throw java.io.IOException("服务器暂时不可用")
                    val raw = response.body?.string().orEmpty()
                    scope?.checkActive()
                    return readResponse(response.code, raw)
                }
            } finally { scope?.release(call) }
        }
        return try { perform(failedBase) } catch (error: java.io.IOException) {
            if (scope?.cancelled == true) throw error
            val switched = RouteManager.failover(baseUrl, failedBase)
            val replay = method == "GET" || method == "HEAD" || (method == "POST" && path == "/messages" && !payload?.optString("request_id").isNullOrBlank())
            if (switched && replay) perform(RouteManager.api(baseUrl))
            else if (switched) throw IllegalStateException("已切换备用线路，请确认操作结果后重试", error)
            else throw error
        }
    }

    private fun readResponse(status: Int, body: String): JSONObject {
        if (status == 426) ClientUpdates.refreshRequired()
        val result = try { JSONObject(body) } catch (_: org.json.JSONException) {
            val repaired = repairObjectTail(body)
            if (repaired == null) throw IllegalStateException(httpError(status))
            try { JSONObject(repaired) } catch (_: org.json.JSONException) { throw IllegalStateException(httpError(status)) }
        }
        if (status !in 200..299 || !result.optBoolean("ok", false)) {
            throw ClientApiException(status, result.optJSONObject("error")?.optString("code").orEmpty(), result.optJSONObject("error")?.optString("message")?.takeIf { it.isNotBlank() } ?: httpError(status))
        }
        return result
    }

    private fun httpError(status: Int): String = when (status) {
        401, 403 -> "登录状态已失效或没有操作权限，请重新登录后重试"
        413 -> "文件超过服务器上传限制，请选择较小的文件或联系管理员调整上传配置"
        408, 504 -> "网络请求超时，请检查网络后重试"
        502, 503 -> "服务器暂时不可用，请稍后重试"
        else -> if (status in 200..299) "服务器返回的数据不完整，请重试" else "请求失败（HTTP $status），请稍后重试"
    }

    private fun repairObjectTail(raw: String): String? {
        val value = raw.trimEnd()
        if (!value.startsWith("{") || !value.endsWith("}")) return null
        var depth = 0
        var quoted = false
        var escaped = false
        for (character in value) {
            if (escaped) { escaped = false; continue }
            if (quoted && character == '\\') { escaped = true; continue }
            if (character == '"') { quoted = !quoted; continue }
            if (quoted) continue
            if (character == '{') depth++
            if (character == '}') depth--
            if (depth < 0) return null
        }
        if (quoted || depth <= 0) return null
        return value + "}".repeat(depth)
    }
}
