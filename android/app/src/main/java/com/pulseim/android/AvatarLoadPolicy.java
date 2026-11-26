package com.pulseim.android;

import java.net.URI;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Bound transient retries and renew a private grant at most once per visible request. */
final class AvatarLoadPolicy {
    enum Next { STOP, RETRY, RENEW }
    private int attempts;
    private boolean renewed;
    void started() { attempts++; }
    Next failed(int status, boolean newerUrl, boolean renewable) {
        if (attempts >= 3) return Next.STOP;
        if (newerUrl) return Next.RETRY;
        if ((status == 401 || status == 403 || status == 404) && renewable && !renewed) {
            renewed = true;
            return Next.RENEW;
        }
        return status <= 0 || status == 408 || status == 429 || status >= 500 && status <= 599 ? Next.RETRY : Next.STOP;
    }
    long delayMs() { return attempts * 1000L; }
    static String mediaId(String base, String identity) {
        try {
            URI api = new URI(base), media = new URI(identity);
            if (!("https".equals(api.getScheme()) || "http".equals(api.getScheme())) || api.getHost() == null
                    || !Objects.equals(api.getScheme(), media.getScheme()) || !Objects.equals(api.getHost(), media.getHost()) || api.getPort() != media.getPort()
                    || media.getUserInfo() != null || media.getRawQuery() != null || media.getRawFragment() != null) return null;
            Matcher match = Pattern.compile(Pattern.quote(api.getPath().replaceAll("/+$", "")) + "/media/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/content").matcher(media.getRawPath());
            return match.matches() ? match.group(1) : null;
        } catch (Exception invalid) { return null; }
    }
}
