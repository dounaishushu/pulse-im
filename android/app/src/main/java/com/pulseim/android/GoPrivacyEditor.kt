package com.pulseim.android

import android.app.Activity
import android.app.AlertDialog
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService

internal object GoPrivacyEditor {
    fun open(activity:Activity,client:ApiClient,executor:ExecutorService,scope:String,current:()->Boolean,shown:(android.app.Dialog)->Unit,done:()->Unit){
        val opening=client.token
        executor.execute {
            try {
                val data=client.goPrivacy();val rule=data.getJSONObject(scope)
                val known=mutableMapOf<String,String>();val reverse=mutableMapOf<String,String>()
                val users=data.optJSONArray("exception_users")?:JSONArray()
                for(i in 0 until users.length()){val u=users.getJSONObject(i);known[u.getString("account")]=u.getString("id");reverse[u.getString("id")]=u.getString("account")}
                activity.runOnUiThread {
                    if(activity.isFinishing||activity.isDestroyed||client.token!=opening||!current())return@runOnUiThread
                    val layout=LinearLayout(activity).apply{orientation=LinearLayout.VERTICAL;setPadding(32,16,32,16)}
                    val choices=listOf("everyone","contacts","nobody");val labels=listOf("所有人","我的联系人","不允许任何人")
                    val group=RadioGroup(activity)
                    choices.forEachIndexed { index,value->group.addView(RadioButton(activity).apply{id=android.view.View.generateViewId();text=labels[index];tag=value;isChecked=rule.getString("visibility")==value}) }
                    layout.addView(group)
                    fun exceptions(key:String,label:String):EditText {
                        layout.addView(TextView(activity).apply{text=label})
                        val values=rule.getJSONArray(key)
                        return EditText(activity).apply{hint="完整账号，以逗号分隔";setText((0 until values.length()).map{reverse[values.getString(it)]?:values.getString(it)}.joinToString(", "));layout.addView(this)}
                    }
                    val allow=exceptions("allow","始终允许")
                    val deny=exceptions("deny","始终拒绝")
                    layout.addView(TextView(activity).apply{text=if(scope=="temporary_chat")"临时聊天规则只影响非好友；拉黑始终生效。" else "邀请仍受拉黑限制。"})
                    val feedback=TextView(activity);layout.addView(feedback)
                    val dialog=AlertDialog.Builder(activity).setTitle(if(scope=="temporary_chat")"临时聊天隐私" else "群邀请隐私").setView(layout).setNegativeButton("取消",null).setPositiveButton("保存",null).create()
                    shown(dialog)
                    dialog.setOnShowListener {dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        if(!current()){dialog.dismiss();return@setOnClickListener}
                        val value=group.findViewById<RadioButton>(group.checkedRadioButtonId)?.tag?.toString()?:return@setOnClickListener
                        val fields=listOf(allow.text.toString(),deny.text.toString());dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled=false;feedback.text="正在保存…"
                        executor.execute {
                            try {
                                fun resolve(text:String):JSONArray {
                                    val accounts=text.split(Regex("[,，;；\\s]+")).filter{it.isNotBlank()};require(accounts.size<=100){"每个名单最多 100 人"}
                                    return JSONArray(accounts.map{account->known[account]?:client.searchUsers(account).let{list->check(list.length()==1){"未找到账号：$account"};list.getJSONObject(0).getString("wire_id")}})
                                }
                                val patch=JSONObject().put("expected_version",data.getString("version")).put(scope,JSONObject().put("visibility",value).put("allow",resolve(fields[0])).put("deny",resolve(fields[1])))
                                check(current()){ "账号或页面已改变，保存已取消" };client.updateGoPrivacy(patch)
                                activity.runOnUiThread{if(dialog.isShowing&&client.token==opening&&current()){dialog.dismiss();done()}}
                            }catch(e:Exception){activity.runOnUiThread{if(dialog.isShowing){feedback.text=e.message?:"保存失败";dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled=true}}}
                        }
                    }};dialog.show()
                }
            }catch(e:Exception){activity.runOnUiThread{if(!activity.isFinishing)Toast.makeText(activity,e.message?:"读取隐私失败",Toast.LENGTH_LONG).show()}}
        }
    }
}
