package com.pulseim.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class PushPermissionPolicyTest {
    @Test public void newAndroidLoginRequestsNotificationAuthorization() {
        assertTrue(PushPermissionPolicy.shouldRequest(33,true,true,false,false));
        assertTrue(PushPermissionPolicy.shouldRequest(37,true,true,false,false));
    }
    @Test public void android12AndEarlierNeverReceiveAnUnsupportedRuntimeRequest() {
        assertFalse(PushPermissionPolicy.shouldRequest(31,true,true,false,false));
        assertFalse(PushPermissionPolicy.shouldRequest(32,true,true,false,false));
    }
    @Test public void anUnconfiguredBuildDoesNotAskForAChannelItCannotProvide() {
        assertFalse(PushPermissionPolicy.shouldRequest(37,false,true,false,false));
    }
    @Test public void signedOutColdStartsDoNotTriggerAPermissionDialog() {
        assertFalse(PushPermissionPolicy.shouldRequest(37,true,false,false,false));
    }
    @Test public void authorizationAlreadyGrantedDoesNotPromptAgain() {
        assertFalse(PushPermissionPolicy.shouldRequest(37,true,true,true,false));
    }
    @Test public void reconnectingAfterADenialDoesNotRepeatedlyPrompt() {
        assertFalse(PushPermissionPolicy.shouldRequest(37,true,true,false,true));
    }
}
