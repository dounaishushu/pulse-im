package com.pulseim.android;

import java.util.Locale;
import java.util.TimeZone;

/** Real date parsing checks; no server, account or Android framework required. */
public final class WorkCompletionTimeChecks {
    public static void main(String[] args) {
        Locale previousLocale = Locale.getDefault();
        TimeZone previousZone = TimeZone.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("th-TH-u-ca-buddhist-nu-thai"));
            TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"));
            String[][] cases = {
                {"2026-11-24T01:49:25.432687Z", "2026-11-24 09:49:25"},
                {"2026-11-24T01:49:25Z", "2026-11-24 09:49:25"},
                {"2026-11-24T01:49:25.432687123+00:00", "2026-11-24 09:49:25"},
                {"2026-11-24T09:49:25.432687+08:00", "2026-11-24 09:49:25"},
                {"2026-11-24T01:49:25.4-05:00", "2026-11-24 14:49:25"},
                {"2026-11-24T23:49:25.987654321Z", "2026-11-25 07:49:25"},
                {"2028-02-29T20:00:00Z", "2028-03-01 04:00:00"},
                {"2026-11-24 09:49:25", "2026-11-24 09:49:25"},
                {"2026-11-24 09:49:25.432687", "2026-11-24 09:49:25"},
                {"2026-11-24T09:49:25.432687", "2026-11-24 09:49:25"},
                {"09:49:25", "09:49:25"},
                {"09:49:25.432687", "09:49:25"},
                {" 2026-11-24T01:49:25.432687Z ", "2026-11-24 09:49:25"},
                {null, "-"}, {"", "-"}, {"   ", "-"}, {"null", "-"}, {"invalid", "-"}
            };
            for (String[] example : cases) {
                String actual = WorkCompletionTime.format(example[0]);
                if (!example[1].equals(actual)) {
                    throw new AssertionError(example[0] + ": expected " + example[1] + ", got " + actual);
                }
            }
            System.out.println("PASS " + cases.length + " completion-time cases (UTC, offsets, fractions, date rollover, legacy data and device locale/timezone)");
        } finally {
            Locale.setDefault(previousLocale);
            TimeZone.setDefault(previousZone);
        }
    }
}
