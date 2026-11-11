package com.pulseim.android

import android.content.Context
import android.graphics.*
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.json.JSONObject
import kotlin.math.roundToInt

/** Identity and a real add-friend QR; exports the same card on a scan-friendly white background. */
internal class MyQrCard(context: Context, user: JSONObject, resolveAvatar: (String) -> String) : ChatScreen(context) {
    private val payload = PublicUserId.friendQr(user.opt("public_id"))
    val ready get() = payload != null
    private val name = jsonText(user, "nickname")
    private val nickname = label(name, 20f).apply {
        id = R.id.my_qr_nickname; gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD
        setTag(R.id.appearance_user_content, true); maxLines = 2; minHeight = px(60)
    }
    private val account = label("${AppAppearance.text("账号")}：${jsonText(user, "username")}", 16f, CHAT_GREY).apply {
        id = R.id.my_qr_username; gravity = Gravity.CENTER; maxLines = 2; minHeight = px(44)
        setTag(R.id.appearance_user_content, true)
    }
    private val publicId = label("用户 ID：${PublicUserId.display(user.opt("public_id"))}", 16f, CHAT_GREY).apply {
        id = R.id.my_qr_public_id; gravity = Gravity.CENTER; maxLines = 2; minHeight = px(44)
        setTag(R.id.appearance_user_content, true)
    }
    private val hint = label(if (ready) "扫一扫上面的二维码图案，加我好友" else "请刷新个人资料后重试", 14.5f, CHAT_GREY).apply {
        id = R.id.my_qr_hint; gravity = Gravity.CENTER; minHeight = px(62)
        breakStrategy = android.text.Layout.BREAK_STRATEGY_BALANCED
    }
    init {
        id = R.id.my_qr_card; background = surface(Color.WHITE, 24)
        setOnApplyWindowInsetsListener(null) // Only the page applies system-bar insets.
        gravity = Gravity.CENTER_HORIZONTAL; setPadding(px(38), px(61), px(38), px(40))
        addView(object : FrameLayout(context) {
            override fun dispatchDraw(canvas: Canvas) {
                // clipToOutline is hardware-only; explicitly retain avatar corners in the exported PNG.
                val state = canvas.save()
                canvas.clipPath(Path().apply { addRoundRect(0f, 0f, width.toFloat(), height.toFloat(), px(24).toFloat(), px(24).toFloat(), Path.Direction.CW) })
                super.dispatchDraw(canvas); canvas.restoreToCount(state)
            }
        }.apply {
            id = R.id.my_qr_avatar; background = surface(0xFFF68A42.toInt(), 24); clipToOutline = true
            addView(label(name.take(1), 28f, Color.WHITE).apply {
                gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD; setTag(R.id.appearance_user_content, true)
            }, FrameLayout.LayoutParams(-1, -1))
            jsonText(user, "avatar_url").takeIf { it.isNotBlank() }?.let { url ->
                addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; ChatAvatars.bind(this, resolveAvatar(url)) }, FrameLayout.LayoutParams(-1, -1))
            }
        }, LayoutParams(px(214), px(214)))
        addView(nickname, LayoutParams(-1, -2).apply { topMargin = px(48) })
        addView(account, LayoutParams(-1, -2).apply { topMargin = px(18) })
        addView(publicId, LayoutParams(-1, -2).apply { topMargin = px(10) })
        if (payload != null) addView(MyQrGraphic(context, payload).apply {
            id = R.id.chat_qr_image; contentDescription = "我的联系人二维码"
        }, LayoutParams(px(502), px(505)).apply { topMargin = px(30) })
        else addView(label("用户 ID 未就绪，暂时无法生成二维码", 16f, CHAT_GREY).apply {
            id = R.id.my_qr_unavailable; gravity = Gravity.CENTER; maxLines = 3
        }, LayoutParams(px(502), px(505)).apply { topMargin = px(30) })
        addView(hint, LayoutParams(-1, -2).apply { topMargin = px(51) })
    }
    fun export(): Bitmap {
        check(ready) { "用户 ID 未就绪，暂时无法保存二维码" }
        check(width > 0 && height > 0) { "二维码尚未加载完成，请稍后重试" }
        // A stable high-resolution export remains readable with dark mode enabled.
        val scale = 1596f / width
        val bitmap = Bitmap.createBitmap(1596, (height * scale).roundToInt(), Bitmap.Config.ARGB_8888)
        val originalBackground = background
        val labels = listOf(nickname, account, publicId, hint)
        val originalColors = labels.map { it.currentTextColor }
        val canvas = Canvas(bitmap).apply { drawColor(Color.WHITE); scale(scale, scale) }
        try {
            background = surface(Color.WHITE, 24)
            nickname.setTextColor(CHAT_INK); account.setTextColor(CHAT_GREY); publicId.setTextColor(CHAT_GREY); hint.setTextColor(CHAT_GREY)
            draw(canvas)
        } catch (e: Exception) { bitmap.recycle(); throw e }
        finally { background = originalBackground; labels.forEachIndexed { i, view -> view.setTextColor(originalColors[i]) } }
        return bitmap
    }
}

/** Flat pulse/chat mark, with high QR error correction and a quiet border around the matrix. */
internal class MyQrGraphic(context: Context, payload: String) : View(context) {
    private val matrix = MultiFormatWriter().encode(payload, BarcodeFormat.QR_CODE, 1, 1, mapOf(
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.H,
        EncodeHintType.CHARACTER_SET to "UTF-8", EncodeHintType.MARGIN to 0
    ))
    private val paint = Paint()
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save()
        val scale = minOf(width / 502f, height / 505f)
        canvas.translate((width - 502 * scale) / 2, (height - 505 * scale) / 2); canvas.scale(scale, scale)
        paint.isAntiAlias = false; paint.style = Paint.Style.FILL; paint.color = Color.WHITE
        canvas.drawRect(0f, 0f, 502f, 505f, paint)
        paint.color = Color.BLACK
        val module = 410f / matrix.width
        for (y in 0 until matrix.height) for (x in 0 until matrix.width) if (matrix[x, y]) {
            canvas.drawRect(46 + x * module, 47 + y * module, 46 + (x + 1) * module, 47 + (y + 1) * module, paint)
        }
        paint.isAntiAlias = true; paint.style = Paint.Style.STROKE; paint.color = MY_BLUE
        paint.strokeWidth = 6f; paint.strokeCap = Paint.Cap.ROUND; paint.strokeJoin = Paint.Join.ROUND
        for ((x, y, sx, sy) in listOf(floatArrayOf(3f, 3f, 1f, 1f), floatArrayOf(499f, 3f, -1f, 1f),
            floatArrayOf(3f, 502f, 1f, -1f), floatArrayOf(499f, 502f, -1f, -1f))) {
            canvas.drawPath(Path().apply {
                moveTo(x, y + sy * 42); lineTo(x, y + sy * 15)
                quadTo(x, y, x + sx * 15, y); lineTo(x + sx * 42, y)
            }, paint)
        }
        paint.style = Paint.Style.FILL; paint.color = Color.WHITE
        canvas.drawRoundRect(222f, 223.5f, 280f, 281.5f, 9f, 9f, paint)
        paint.color = MY_BLUE
        canvas.drawRoundRect(231f, 232.5f, 271f, 267.5f, 9f, 9f, paint)
        canvas.drawPath(Path().apply { moveTo(238f, 264f); lineTo(236f, 276f); lineTo(251f, 266f); close() }, paint)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 2.8f; paint.color = Color.WHITE
        canvas.drawPath(Path().apply {
            moveTo(237f, 250f); lineTo(243f, 250f); lineTo(247f, 242f); lineTo(253f, 259f); lineTo(257f, 250f); lineTo(266f, 250f)
        }, paint)
        canvas.restore()
    }
}
