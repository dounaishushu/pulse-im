package com.pulseim.android

/** Test fixtures follow state properties after their backing fields move to the ViewModel. */
internal object ChatProbeAccess {
    fun get(host: MainActivity, name: String): Any? {
        if (name in listOf("textExecutor", "photoUploadExecutor") &&
            host.javaClass.declaredMethods.any { it.name.substringBefore('$') == "getChatSender" }) {
            val sender = get(host, "chatSender") as ChatSendController
            val ports = sender.javaClass.getDeclaredField("ports").apply { isAccessible = true }.get(sender) as ChatSendPorts
            return if (name == "textExecutor") ports.textNetwork else ports.mediaNetwork
        }
        host.javaClass.declaredFields.firstOrNull { it.name == name }?.let {
            return it.apply { isAccessible = true }.get(host)
        }
        val getter = "get" + name.replaceFirstChar { it.uppercaseChar() }
        host.javaClass.declaredMethods.firstOrNull { it.name.substringBefore('$') == getter && it.parameterCount == 0 }?.let {
            return it.apply { isAccessible = true }.invoke(host)
        }
        return host.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(host)
    }
    fun set(host: MainActivity, name: String, value: Any?) {
        host.javaClass.declaredFields.firstOrNull { it.name == name }?.let {
            it.apply { isAccessible = true }.set(host, value)
            return
        }
        val setter = "set" + name.replaceFirstChar { it.uppercaseChar() }
        host.javaClass.declaredMethods.firstOrNull { it.name.substringBefore('$') == setter && it.parameterCount == 1 }?.let {
            it.apply { isAccessible = true }.invoke(host, value)
            return
        }
        host.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(host, value)
    }
}
