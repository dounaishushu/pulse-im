package com.pulseim.android

import android.content.Context
import android.graphics.Bitmap
import java.io.File

internal object MediaIdentityChecks {
    fun benchmark(context: Context):org.json.JSONObject {
        GoV2Ids.context=context.applicationContext
        val base="http://127.0.0.1:18124/api/v2";val scope="$base|key-benchmark"
        val url="$base/media-grants/"+"c".repeat(64)+"/content"
        GoMediaIdentity.remember(base,"key-benchmark","ee111111-1111-4111-8111-111111111111",url)
        val expected=ChatImageCache.key(scope,url)
        val started=android.os.SystemClock.elapsedRealtimeNanos()
        repeat(5000){check(ChatImageCache.key(scope,url)==expected)}
        return org.json.JSONObject().put("iterations",5000).put("elapsedMs",(android.os.SystemClock.elapsedRealtimeNanos()-started)/1_000_000.0)
    }
    fun run(context: Context) {
        GoV2Ids.context=context.applicationContext
        val base="http://127.0.0.1:18124/api/v2";val token="identity-"+java.util.UUID.randomUUID();val scope="$base|$token"
        val id="ee111111-1111-4111-8111-111111111111"
        val a="http://127.0.0.1:18124/api/v2/media-grants/"+"a".repeat(64)+"/content"
        val b=a.replace("a".repeat(64),"b".repeat(64))
        GoMediaIdentity.remember(base,token,id,a);GoMediaIdentity.remember(base,token,id,b)
        check(ChatImageCache.key(scope,a)==ChatImageCache.key(scope,b)) {"rotating Go access bypasses image cache"}
        check(ChatImageCache.key(scope,a)!=ChatImageCache.key(scope,b.removeSuffix("content")+"preview"))
        check(ChatImageCache.key(scope,a)!=ChatImageCache.key("$base|other",a))
        val late=a.replace("a".repeat(64),"d".repeat(64));val unresolved=ChatImageCache.key(scope,late)
        GoMediaIdentity.remember(base,token,id,late)
        check(ChatImageCache.key(scope,late)==ChatImageCache.key(scope,a)&&ChatImageCache.key(scope,late)!=unresolved)
        ChatAvatars.account(base,1,token)
        check(ChatAvatars.identity(a)==ChatAvatars.identity(b)) {"rotating Go access bypasses avatar cache"}
        val file=File(context.cacheDir,"identity-${java.util.UUID.randomUUID()}.png")
        val bitmap=Bitmap.createBitmap(64,48,Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(android.graphics.Color.GREEN)
        try {
            file.outputStream().use {check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it))}
            ChatImageCache.seedUploaded(context,scope,a,file){true}
            GoMediaIdentity.flushBindings();GoMediaIdentity.discardMemoryForTest();ChatImageCache.clearMemory()
            val reused=ChatImageCache.load(context,scope,b,1024){true}
            check(reused.width==64&&reused.height==48) {"cached bytes were not reused after grant rotation and memory eviction"}
            check(ChatAvatars.identity(a)==ChatAvatars.identity(b)) {"persisted avatar alias was lost"}
        } finally {bitmap.recycle();file.delete()}
    }
}
