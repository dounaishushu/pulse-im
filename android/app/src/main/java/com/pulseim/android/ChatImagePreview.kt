package com.pulseim.android

import android.net.Uri

/** Ask the private media handler for a bounded preview. Original links are kept for the gallery. */
internal object ChatImagePreview {
    fun url(raw: String): String = runCatching {
        val uri = Uri.parse(raw)
        if (uri.scheme !in listOf("https", "http") || uri.host.isNullOrBlank() || uri.userInfo != null) return raw
        if (!listOf("media_expires", "media_signature", "media_session", "media_kind").all { !uri.getQueryParameter(it).isNullOrBlank() }) return raw
        val path = if (uri.path.orEmpty().endsWith("/media")) uri.getQueryParameter("path").orEmpty()
            else uri.path.orEmpty().substringAfter("/storage/", "")
        if (!Regex("uploads/\\d{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{32}\\.(?:jpg|jpeg|png|gif|webp)").matches(path)) return raw
        uri.buildUpon().clearQuery().apply {
            uri.queryParameterNames.filter { it != "media_preview" }.forEach { key -> uri.getQueryParameters(key).forEach { appendQueryParameter(key, it) } }
            appendQueryParameter("media_preview", "640")
        }.build().toString()
    }.getOrDefault(raw)
}
