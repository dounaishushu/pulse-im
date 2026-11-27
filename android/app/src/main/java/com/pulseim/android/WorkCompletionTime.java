package com.pulseim.android;

import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Locale;

/** Formats task timestamps in the task calendar's Beijing time zone. */
final class WorkCompletionTime {
    private static final ZoneId BEIJING = ZoneId.of("Asia/Shanghai");
    private static final DateTimeFormatter DATE_TIME =
            DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss", Locale.ROOT);
    private static final DateTimeFormatter TIME =
            DateTimeFormatter.ofPattern("HH:mm:ss", Locale.ROOT);

    private WorkCompletionTime() {}

    static String format(String value) {
        String raw = value == null ? "" : value.trim();
        if (raw.isEmpty()) return "-";
        String normalized = raw.length() > 10 && raw.charAt(10) == ' '
                ? raw.substring(0, 10) + "T" + raw.substring(11) : raw;
        try {
            return OffsetDateTime.parse(normalized, DateTimeFormatter.ISO_OFFSET_DATE_TIME)
                    .atZoneSameInstant(BEIJING).format(DATE_TIME);
        } catch (DateTimeParseException ignored) {
            // Legacy timestamps without an offset already use Beijing time.
        }
        try {
            return LocalDateTime.parse(normalized, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                    .format(DATE_TIME);
        } catch (DateTimeParseException ignored) {
            // Older records may contain a time without a calendar date.
        }
        try {
            return LocalTime.parse(raw, DateTimeFormatter.ISO_LOCAL_TIME).format(TIME);
        } catch (DateTimeParseException ignored) {
            return "-";
        }
    }
}
