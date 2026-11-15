package com.pulseim.android

import android.app.Instrumentation
import android.os.Bundle
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import org.json.JSONObject

internal object LiveRegistrationChecks {
    fun run(instrumentation:Instrumentation,args:Bundle) {
        val result=Bundle()
        try {
            val context=instrumentation.targetContext
            GoV2Ids.context=context.applicationContext;MobileDeviceIdentity.initialize(context)
            val account=requireNotNull(args.getString("account"));require(Regex("rel[a-f0-9]{6}").matches(account))
            val password=requireNotNull(args.getString("password"))
            val glyphs=JSONObject(String(Base64.decode(requireNotNull(args.getString("glyphs")),Base64.NO_WRAP),Charsets.UTF_8))
            val client=ApiClient("https://api.imapi.shop/api/v2")
            val captcha=client.registerChallenge()
            val bytes=Base64.decode(captcha.getString("image_data_url").substringAfter(','),Base64.NO_WRAP)
            val image=BitmapFactory.decodeByteArray(bytes,0,bytes.size)
            val code=StringBuilder()
            for(i in 0 until 5){
                val found=mutableSetOf<Int>()
                for(y in 0 until 16)for(x in 0 until 8)if(image.getPixel(18+i*25+x,28+(i%2)*4-13+y)==android.graphics.Color.rgb(24,42,64))found.add(y*8+x)
                val candidates=glyphs.keys().asSequence().map{key->val cells=glyphs.getJSONArray(key);val expected=(0 until cells.length()).map{cells.getInt(it)}.toSet();key to (found.minus(expected).size+expected.minus(found).size)}.sortedBy{it.second}.toList()
                check(candidates[0].second<=2&&candidates[0].second<candidates[1].second);code.append(candidates[0].first)
            }
            image.recycle()
            val avatar=Bitmap.createBitmap(64,64,Bitmap.Config.ARGB_8888).apply{eraseColor(android.graphics.Color.rgb(24,160,128))}
            val stream=java.io.ByteArrayOutputStream();check(avatar.compress(Bitmap.CompressFormat.PNG,100,stream));avatar.recycle()
            val login=client.register(account,password,"安卓注册验收",captcha.getString("challenge_id"),code.toString(),avatarDataURL="data:image/png;base64,"+Base64.encodeToString(stream.toByteArray(),Base64.NO_WRAP))
            client.token=login.getString("access_token")
            val profile=client.me();check(profile.getString("username")==account)
            result.putString("result","passed");result.putString("account",account);result.putString("wire_id",profile.getString("wire_id"))
            result.putString("checks","actual Android ApiClient challenge, captcha decoding, required avatar registration, automatic login and persisted profile on deployed Go")
            instrumentation.finish(android.app.Activity.RESULT_OK,result)
        } catch(error:Throwable){result.putString("result","failed");result.putString("error",error.javaClass.simpleName+": "+error.message);instrumentation.finish(android.app.Activity.RESULT_CANCELED,result)}
    }
}
