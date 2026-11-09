package com.pulseim.android

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.MediaController
import android.widget.TextView
import android.widget.VideoView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/** The system photo picker grants access to the chosen video without library permission. */
internal object ChatVideoPicker {
    fun intent(activity: Activity): Intent {
        val modern = Intent(MediaStore.ACTION_PICK_IMAGES).setType("video/*")
        if (Build.VERSION.SDK_INT >= 33 || modern.resolveActivity(activity.packageManager) != null) return modern
        val gallery = Intent(Intent.ACTION_PICK, MediaStore.Video.Media.EXTERNAL_CONTENT_URI).setType("video/*")
        if (gallery.resolveActivity(activity.packageManager) != null) return gallery
        return Intent(Intent.ACTION_OPEN_DOCUMENT).setType("video/*").addCategory(Intent.CATEGORY_OPENABLE)
    }
}

/** Keep selection local until the user explicitly taps Send. */
internal class ChatVideoSendPreview(
    private val activity: Activity,
    uri: Uri,
    onSend: () -> Unit,
    onClosed: () -> Unit
) : Dialog(activity, if (AppAppearance.dark) R.style.AppThemeDark else R.style.AppTheme) {
    private val video = VideoView(activity)
    private val root = FrameLayout(activity)
    private var submitted = false
    private fun dp(value: Int) = (activity.resources.displayMetrics.density * value + .5f).toInt()
    init {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        root.setBackgroundColor(Color.BLACK)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        video.id = R.id.video_preview_player
        root.addView(video, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER).apply { topMargin = dp(56); bottomMargin = dp(80) })
        val status = TextView(activity).apply {
            id = R.id.video_preview_status; text = "视频加载中…"; textSize = 14f
            setTextColor(Color.WHITE); gravity = Gravity.CENTER
        }
        root.addView(status, FrameLayout.LayoutParams(-1, -1).apply { topMargin = dp(56); bottomMargin = dp(80) })
        root.addView(TextView(activity).apply {
            text = "视频预览"; textSize = 17f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
        }, FrameLayout.LayoutParams(-1, dp(56)).apply { leftMargin = dp(72); rightMargin = dp(72) })
        root.addView(TextView(activity).apply {
            text = "返回"; textSize = 16f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            contentDescription = "返回相册"; setOnClickListener { dismiss() }
        }, FrameLayout.LayoutParams(dp(72), dp(56), Gravity.TOP or Gravity.START))
        root.addView(TextView(activity).apply {
            id = R.id.video_preview_send; text = "发送"; textSize = 16f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            contentDescription = "发送此视频"
            setOnClickListener { if (!submitted) { submitted = true; isEnabled = false; onSend(); dismiss() } }
        }, FrameLayout.LayoutParams(dp(72), dp(56), Gravity.TOP or Gravity.END))
        root.addView(imagePreviewCloseButton(activity) { dismiss() }.apply {
            id = R.id.video_preview_close; contentDescription = "关闭视频预览，返回相册"
        }, FrameLayout.LayoutParams(dp(84), dp(48), Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(12); bottomMargin = dp(12) })
        root.addView(TextView(activity).apply {
            text = "视频单独发送，最大100MB"; textSize = 12f; setTextColor(Color.LTGRAY); gravity = Gravity.CENTER
        }, FrameLayout.LayoutParams(-1, dp(48), Gravity.BOTTOM).apply { leftMargin = dp(108); bottomMargin = dp(12) })
        video.setMediaController(MediaController(activity).apply { setAnchorView(video) })
        video.setOnPreparedListener { if (isShowing) video.start() else video.stopPlayback() }
        video.setOnInfoListener { _, what, _ ->
            if (isShowing && what == android.media.MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) status.visibility = View.GONE
            false
        }
        video.setOnErrorListener { _, _, _ -> status.text = "此视频暂时无法预览，仍可点击发送"; status.visibility = View.VISIBLE; true }
        setContentView(root)
        setOnDismissListener { runCatching { video.stopPlayback() }; onClosed() }
        video.setVideoURI(uri)
    }
    override fun show() {
        super.show()
        window?.apply {
            setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
            setBackgroundDrawableResource(android.R.color.black)
            statusBarColor = Color.BLACK; navigationBarColor = Color.BLACK
            WindowCompat.setDecorFitsSystemWindows(this, false)
            WindowCompat.getInsetsController(this, root).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
        }
        ViewCompat.requestApplyInsets(root)
    }
}
