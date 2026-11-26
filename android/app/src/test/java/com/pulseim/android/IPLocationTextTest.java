package com.pulseim.android;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class IPLocationTextTest {
    @Test public void keepsAllThreeProviderFields() {
        assertEquals("United States-California-Los Angeles", IPLocationText.format("United States", "California", "Los Angeles", "old"));
        assertEquals("中国-广东省-深圳市", IPLocationText.format("中国", "广东省", "深圳市", ""));
    }
    @Test public void municipalityDoesNotLoseACorrespondingField() {
        assertEquals("中国-北京市-北京市", IPLocationText.format("中国", "北京市", "北京市", ""));
    }
    @Test public void partialProviderDataIsNotInvented() {
        assertEquals("China-深圳市", IPLocationText.format(" China ", null, " 深圳市 ", "old"));
        assertEquals("China", IPLocationText.format("China", "", "", "old"));
    }
    @Test public void missingDetailsRetainOldBackendText() {
        assertEquals("旧版归属地", IPLocationText.format(null, null, null, "旧版归属地"));
        assertEquals("", IPLocationText.format("", " ", null, null));
    }
    @Test public void invalidComponentsAreRejected() {
        assertEquals("中国", IPLocationText.format("中国", "bad\u0000region", "x".repeat(129), "old"));
    }
    @Test public void separateAccountsAndAddressesShareNoState() {
        assertEquals("中国-浙江省-杭州市", IPLocationText.format("中国", "浙江省", "杭州市", ""));
        assertEquals("United States-California-Los Angeles", IPLocationText.format("United States", "California", "Los Angeles", ""));
        assertEquals("", IPLocationText.format(null, null, null, ""));
    }
}
