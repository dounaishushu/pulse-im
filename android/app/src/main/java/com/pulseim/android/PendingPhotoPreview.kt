package com.pulseim.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.drawable.GradientDrawable
import android.media.ExifInterface
import android.net.Uri
import android.util.LruCache
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import java.util.concurrent.Executors

/** A local thumbnail is UI feedback, never evidence that a message was sent. */
internal class PendingPhotoPreview(context: Context) : LinearLayout(context) {
    val image = ImageView(context).apply { scaleType=ImageView.ScaleType.FIT_CENTER; contentDescription="待发送图片" }
    private val progress=ProgressBar(context).apply { importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO }
    private val feedback=TextView(context).apply { textSize=12f;setTextColor(0xFFDC4545.toInt());gravity=Gravity.END;minHeight=dp(32) }
    private val remove=TextView(context).apply { text="移除";textSize=12f;setTextColor(0xFF888888.toInt());gravity=Gravity.END;minHeight=dp(32) }
    private fun dp(n:Int)=(context.resources.displayMetrics.density*n+.5f).toInt()
    init {
        orientation=HORIZONTAL;gravity=Gravity.END;setPadding(dp(12),dp(6),dp(12),dp(6))
        val width=dp(230).coerceAtMost(context.resources.displayMetrics.widthPixels-dp(76))
        addView(LinearLayout(context).apply {
            orientation=VERTICAL;gravity=Gravity.END
            addView(FrameLayout(context).apply {
                background=GradientDrawable().apply{setColor(0x08777777);cornerRadius=dp(12).toFloat()};clipToOutline=true
                addView(image,FrameLayout.LayoutParams(-1,-1))
                addView(progress,FrameLayout.LayoutParams(dp(20),dp(20),Gravity.BOTTOM or Gravity.END).apply{rightMargin=dp(6);bottomMargin=dp(6)})
            },LayoutParams(width,width))
            addView(feedback,LayoutParams(-1,-2));addView(remove,LayoutParams(-1,-2))
        })
        update(false,"",{},{} )
    }
    fun update(failed:Boolean,error:String,retry:()->Unit,discard:()->Unit) {
        progress.visibility=if(failed)GONE else VISIBLE
        feedback.visibility=if(failed)VISIBLE else GONE;remove.visibility=if(failed)VISIBLE else GONE
        feedback.text=error.ifBlank{"发送未确认"}+" · 点击重试";feedback.setOnClickListener{retry()};remove.setOnClickListener{discard()}
        contentDescription=if(failed)"图片发送失败，可重试或移除" else "图片发送中"
    }
}

/** Decode bounded thumbnails off the main thread and retain them across phase updates. */
internal class PendingPhotoThumbnails {
    private val worker=Executors.newFixedThreadPool(2)
    private val cache=object:LruCache<String,Bitmap>(12*1024*1024){override fun sizeOf(key:String,value:Bitmap)=value.allocationByteCount}
    @Volatile private var generation=0
    fun cached(key:String):Bitmap?=cache.get(key)
    fun clear(){generation++;cache.evictAll()}
    fun close(){clear();worker.shutdownNow()}
    fun forget(key:String){cache.remove(key)}
    fun bind(image:ImageView,key:String,current:()->Boolean,load:()->Bitmap) {
        if(!current())return
        cached(key)?.let{image.tag=key;image.setImageBitmap(it);return}
        if(image.tag==key)return
        image.tag=key;val version=generation
        worker.execute {
            val bitmap=runCatching{load()}.getOrNull()
            if(bitmap==null){image.post{if(image.tag==key)image.tag=null};return@execute}
            image.post {
                if(version==generation&&current()&&image.tag==key&&image.isAttachedToWindow){cache.put(key,bitmap);image.setImageBitmap(bitmap)}
                else bitmap.recycle()
            }
        }
    }
    companion object {
        fun decode(context:Context,uri:Uri):Bitmap {
            val resolver=context.contentResolver
            val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true}
            resolver.openInputStream(uri)?.use{BitmapFactory.decodeStream(it,null,bounds)}
            require(bounds.outWidth>0&&bounds.outHeight>0){"图片无法预览"}
            val options=BitmapFactory.Options().apply{inPreferredConfig=Bitmap.Config.ARGB_8888;inSampleSize=1;while(bounds.outWidth/inSampleSize>768||bounds.outHeight/inSampleSize>768)inSampleSize*=2}
            val bitmap=resolver.openInputStream(uri)?.use{BitmapFactory.decodeStream(it,null,options)}?:error("图片无法读取")
            val orientation=runCatching{resolver.openInputStream(uri)?.use{ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL)}}.getOrNull()
            val matrix=Matrix().apply{when(orientation){
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL->setScale(-1f,1f)
                ExifInterface.ORIENTATION_ROTATE_180->setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL->setScale(1f,-1f)
                ExifInterface.ORIENTATION_TRANSPOSE->{setRotate(90f);postScale(-1f,1f)}
                ExifInterface.ORIENTATION_ROTATE_90->setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE->{setRotate(-90f);postScale(-1f,1f)}
                ExifInterface.ORIENTATION_ROTATE_270->setRotate(-90f)
            }}
            return if(matrix.isIdentity)bitmap else Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,matrix,true).also{if(it!==bitmap)bitmap.recycle()}
        }
    }
}
