package com.pulseim.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class AvatarLoadPolicyTest {
    private static final String BASE = "https://api.example.test/api/v2";
    private static final String ID = "00000000-1111-2222-3333-444444444444";
    @Test public void expiredPrivateGrantRenewsOnce() {
        AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
        assertEquals(AvatarLoadPolicy.Next.RENEW, p.failed(403, false, true));
        p.started(); assertEquals(AvatarLoadPolicy.Next.STOP, p.failed(403, false, true));
    }
    @Test public void expiredGrantNotFoundCanRenewButPublicNotFoundStops() {
        AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
        assertEquals(AvatarLoadPolicy.Next.RENEW, p.failed(404, false, true));
        AvatarLoadPolicy publicAvatar = new AvatarLoadPolicy(); publicAvatar.started();
        assertEquals(AvatarLoadPolicy.Next.STOP, publicAvatar.failed(404, false, false));
    }
    @Test public void transientFailuresStopAfterThreeAttempts() {
        for (int transport : new int[]{0, -1}) {
            AvatarLoadPolicy p = new AvatarLoadPolicy();
            p.started(); assertEquals(AvatarLoadPolicy.Next.RETRY, p.failed(transport, false, false)); assertEquals(1000, p.delayMs());
            p.started(); assertEquals(AvatarLoadPolicy.Next.RETRY, p.failed(503, false, false)); assertEquals(2000, p.delayMs());
            p.started(); assertEquals(AvatarLoadPolicy.Next.STOP, p.failed(503, false, false));
        }
    }
    @Test public void rateLimitsAndRequestTimeoutsGetABoundedRetry() {
        for (int status : new int[]{408, 429, 500, 502, 504}) {
            AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
            assertEquals(AvatarLoadPolicy.Next.RETRY, p.failed(status, false, false));
        }
    }
    @Test public void permanentFailuresDoNotLoop() {
        for (int status : new int[]{301, 400, 401, 403, 404, 422}) {
            AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
            assertEquals(AvatarLoadPolicy.Next.STOP, p.failed(status, false, false));
        }
    }
    @Test public void aNewerBoundUrlIsTriedBeforeRequestingAnotherGrant() {
        AvatarLoadPolicy p = new AvatarLoadPolicy(); p.started();
        assertEquals(AvatarLoadPolicy.Next.RETRY, p.failed(403, true, true));
        p.started(); assertEquals(AvatarLoadPolicy.Next.RENEW, p.failed(403, false, true));
        p.started(); assertEquals(AvatarLoadPolicy.Next.STOP, p.failed(403, true, true));
    }
    @Test public void mediaIdentityMustBelongToTheCapturedApi() {
        assertEquals(ID, AvatarLoadPolicy.mediaId(BASE, BASE + "/media/" + ID + "/content"));
        assertEquals(ID, AvatarLoadPolicy.mediaId(BASE + "/", BASE + "/media/" + ID + "/content"));
        assertNull(AvatarLoadPolicy.mediaId(BASE, "https://elsewhere.test/api/v2/media/" + ID + "/content"));
        assertNull(AvatarLoadPolicy.mediaId(BASE, "http://api.example.test/api/v2/media/" + ID + "/content"));
        assertNull(AvatarLoadPolicy.mediaId(BASE, "https://api.example.test:444/api/v2/media/" + ID + "/content"));
    }
    @Test public void mediaIdentityRejectsCredentialsQueriesAndUntrustedPaths() {
        for (String raw : new String[]{BASE + "/media/" + ID + "/content?token=secret", BASE + "/media/" + ID + "/content#fragment",
                BASE + "/media/" + ID + "/preview", BASE + "/media/../media/" + ID + "/content", BASE + "/media/%30" + ID.substring(1) + "/content",
                "https://name@api.example.test/api/v2/media/" + ID + "/content", "bad"}) {
            assertNull(raw, AvatarLoadPolicy.mediaId(BASE, raw));
        }
    }
}
