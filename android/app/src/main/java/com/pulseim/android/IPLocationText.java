package com.pulseim.android;

/** Pure display logic shared by registration and latest-login profile fields. */
final class IPLocationText {
    private IPLocationText() {}

    static String format(String country, String region, String city, String fallback) {
        StringBuilder text = new StringBuilder();
        for (String value : new String[] { country, region, city }) {
            String part = clean(value);
            if (part.isEmpty()) continue;
            if (text.length() > 0) text.append('-');
            text.append(part);
        }
        return text.length() > 0 ? text.toString() : fallback == null ? "" : fallback;
    }

    static String clean(String value) {
        if (value == null) return "";
        String text = value.trim();
        if (text.length() > 128) return "";
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (ch < 32 || ch == 127) return "";
        }
        return text;
    }
}
