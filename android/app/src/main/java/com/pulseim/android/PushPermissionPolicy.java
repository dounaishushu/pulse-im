package com.pulseim.android;

final class PushPermissionPolicy {
    static boolean shouldRequest(int sdk, boolean configured, boolean signedIn, boolean granted, boolean alreadyAsked) {
        return sdk >= 33 && configured && signedIn && !granted && !alreadyAsked;
    }
    private PushPermissionPolicy() {}
}
