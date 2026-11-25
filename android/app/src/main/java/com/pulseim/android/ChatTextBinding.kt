package com.pulseim.android

/** Keep viewer-resolved text authoritative; do not expose a raw intermediate value. */
internal object ChatTextBinding {
    inline fun bind(current: CharSequence?, fallback: String, namesResolveText: Boolean,
             write: (String) -> Unit, names: () -> Unit) {
        if (!namesResolveText) value(current, fallback, write)
        // Even unchanged text needs fresh name metadata for later contact updates.
        names()
    }

    inline fun value(current: CharSequence?, next: String, write: (String) -> Unit) {
        if (current?.toString() != next) write(next)
    }
}
