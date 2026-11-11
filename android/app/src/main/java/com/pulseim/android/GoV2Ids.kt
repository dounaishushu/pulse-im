package com.pulseim.android

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.io.File

/** UI handles are local keys, never network identities or authorization evidence.
 * All outbound IDs are resolved back to UUIDs for the same endpoint and kind. */
internal object GoV2Ids {
    lateinit var context: Context
    private var helper: SQLiteOpenHelper? = null
    @Synchronized private fun db(): SQLiteDatabase {
        if (helper == null) helper = object : SQLiteOpenHelper(context, File(context.noBackupFilesDir,"go-v2-identifiers.db").absolutePath,null,1) {
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL("CREATE TABLE ids(local INTEGER PRIMARY KEY AUTOINCREMENT,base TEXT NOT NULL,kind TEXT NOT NULL,wire TEXT NOT NULL,UNIQUE(base,kind,wire))")
                db.execSQL("CREATE TABLE messages(base TEXT NOT NULL,cid INTEGER NOT NULL,seq INTEGER NOT NULL,wire TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(base,cid,seq))")
                db.execSQL("CREATE TABLE memberships(base TEXT NOT NULL,uid INTEGER NOT NULL,cid INTEGER NOT NULL,version TEXT NOT NULL,PRIMARY KEY(base,uid,cid))")
            }
            override fun onUpgrade(db: SQLiteDatabase,oldVersion:Int,newVersion:Int)=Unit
        }.apply{setWriteAheadLoggingEnabled(true)}
        return requireNotNull(helper).writableDatabase
    }
    @Synchronized fun local(base:String,kind:String,wire:String):Int {
        require(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(wire)){"服务器返回无效标识"}
        val d=db();d.execSQL("INSERT OR IGNORE INTO ids(base,kind,wire) VALUES(?,?,?)",arrayOf(base,kind,wire))
        return d.rawQuery("SELECT local FROM ids WHERE base=? AND kind=? AND wire=?",arrayOf(base,kind,wire)).use{check(it.moveToFirst());exact(it.getLong(0))}
    }
    @Synchronized fun wire(base:String,kind:String,id:Int):String = db().rawQuery("SELECT wire FROM ids WHERE base=? AND kind=? AND local=?",arrayOf(base,kind,id.toString())).use {
        check(it.moveToFirst()) { "本地标识已失效，请重新打开此页面" };it.getString(0)
    }
    fun exact(value:Long):Int { check(value in 0..Int.MAX_VALUE.toLong()){ "消息范围超出当前客户端支持，请更新客户端" };return value.toInt() }
    @Synchronized fun message(base:String,cid:Int,value:JSONObject) {
        val seq=exact(value.getString("seq").toLong());val wire=value.getString("id");val version=value.getString("version").toLong()
        require(seq>0&&version>0&&Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(wire))
        val d=db()
        val previous=d.rawQuery("SELECT wire,version FROM messages WHERE base=? AND cid=? AND seq=?",arrayOf(base,cid.toString(),seq.toString())).use{if(it.moveToFirst())it.getString(0) to it.getString(1).toLong() else null}
        check(previous==null||previous.first==wire){"消息标识发生冲突，请重新同步"}
        if(previous==null||version>previous.second)d.execSQL("INSERT OR REPLACE INTO messages(base,cid,seq,wire,version) VALUES(?,?,?,?,?)",arrayOf(base,cid,seq,wire,version.toString()))
    }
    @Synchronized fun message(base:String,cid:Int,seq:Int):Pair<String,String> = db().rawQuery("SELECT wire,version FROM messages WHERE base=? AND cid=? AND seq=?",arrayOf(base,cid.toString(),seq.toString())).use {
        check(it.moveToFirst()){ "消息未同步，请刷新后重试" };it.getString(0) to it.getString(1)
    }
    @Synchronized fun membership(base:String,uid:Int,cid:Int,version:String,token:String?):Boolean {
        val d=db();val old=d.rawQuery("SELECT version FROM memberships WHERE base=? AND uid=? AND cid=?",arrayOf(base,uid.toString(),cid.toString())).use{if(it.moveToFirst())it.getString(0) else null}
        if(old!=null&&old!=version){
            val scope=LocalChatStore.scope(base,uid,token)
            LocalChatStore.clearConversation(context,scope,cid)
            LocalMediaCache.purge(context,LocalAccountStore.scope(base,uid),cid)
        }
        d.execSQL("INSERT OR REPLACE INTO memberships(base,uid,cid,version) VALUES(?,?,?,?)",arrayOf(base,uid,cid,version))
        return old!=null&&old!=version
    }
}

/** Version authority is distinct from the human-readable edit timestamp. */
internal fun JSONObject.messageAuthority():String = optString("_go_version").takeIf{it.isNotBlank()} ?: optString("edited_at").takeUnless{it=="null"}.orEmpty()
