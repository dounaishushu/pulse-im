package com.pulseim.android

import android.app.Activity
import android.app.Instrumentation
import android.graphics.Bitmap
import android.os.Bundle
import org.json.JSONObject
import java.io.File

internal object MediaCacheProbe {
    fun run(probe: Instrumentation,args:Bundle) {
        val report=JSONObject();val result=Bundle();var source:File?=null
        try {
            val context=probe.targetContext;GoV2Ids.context=context.applicationContext;MobileDeviceIdentity.initialize(context)
            val base=requireNotNull(args.getString("base"));require(base.startsWith("http://10.0.2.2:"))
            val prefix=requireNotNull(args.getString("prefix"));require(prefix.startsWith("picker"));val password=requireNotNull(args.getString("password"))
            RouteManager.initialize(context,base,base.replaceFirst("http://","ws://")+"/realtime")
            val a=ApiClient(base).apply {token=login(prefix+"a",password)};val b=ApiClient(base).apply {token=login(prefix+"b",password)}
            val chat=a.createDirectConversation(b.me().getInt("id"));val cid=chat.getInt("id")
            val file=File(context.cacheDir,"cache-key-${System.nanoTime()}.png");source=file
            val bitmap=Bitmap.createBitmap(96,72,Bitmap.Config.ARGB_8888);bitmap.eraseColor(android.graphics.Color.BLUE)
            file.outputStream().use {check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it))};bitmap.recycle()
            val upload=a.uploadMedia(file,"image","image/png")
            val sent=a.sendMediaMessage(cid,"image",upload,"media-key-${java.util.UUID.randomUUID()}")
            val first=sent.getJSONObject("body").getString("url")
            val fresh=ApiClient(base).apply {token=a.token}.historyPage(cid,0,50).items.first {it.getInt("id")==sent.getInt("id")}
            val second=fresh.getJSONObject("body").getString("url");val scope=base+"|"+a.token
            check(first!=second) {"fixture did not rotate the Go capability"}
            ChatImageCache.seedUploaded(context,scope,first,file){true}
            val same=ChatImageCache.key(scope,first)==ChatImageCache.key(scope,second)
            val reused=ChatImageCache.cached(scope,second)!=null
            report.put("version",context.packageManager.getPackageInfo(context.packageName,0).versionName).put("sdk",android.os.Build.VERSION.SDK_INT)
                .put("capabilityRotated",true).put("sameCacheKey",same).put("reusedDecodedBitmap",reused)
            if(args.getString("baseline")=="true") {
                check(!same&&!reused) {"baseline did not reproduce rotating-key cache miss"};result.putString("result","reproduced")
            } else {
                check(same&&reused)
                GoMediaIdentity.flushBindings();GoMediaIdentity.discardMemoryForTest();ChatImageCache.clearMemory()
                val cold=ChatImageCache.load(context,scope,second,1024){true};check(cold.width==96&&cold.height==72)
                report.put("reusedAfterMemoryEviction",true)
                MediaIdentityChecks.run(context);report.put("avatarAndAccountIsolation",true)
                result.putString("result","passed")
            }
        }catch(error:Throwable){result.putString("result","failed");report.put("error",error.toString()).put("stack",error.stackTrace.take(5).joinToString("\n"))}
        finally {source?.delete()}
        result.putString("report",report.toString());probe.finish(if(result.getString("result")=="failed")Activity.RESULT_CANCELED else Activity.RESULT_OK,result)
    }
}
