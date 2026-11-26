package com.pulseim.android;

import org.junit.Test;
import java.util.HashMap;
import java.util.Map;
import static org.junit.Assert.*;

public class PushMessagePolicyTest {
    private static final String OWNER = "11111111-1111-4111-8111-111111111111";
    private static final String CONVERSATION = "22222222-2222-4222-8222-222222222222";
    private static final String MESSAGE = "33333333-3333-4333-8333-333333333333";
    private static class Ids implements PushMessagePolicy.Identifiers {
        int users, conversations;
        String wire;
        int local = 71;
        public String user(int id) { assertEquals(11, id); users++; return OWNER; }
        public int conversation(String value) { conversations++; wire = value; return local; }
    }
    private Map<String,String> go() {
        Map<String,String> data = new HashMap<>();
        data.put("user_id", OWNER); data.put("conversation_id", CONVERSATION); data.put("message_id", MESSAGE);
        data.put("seq", "23"); data.put("conversation_type", "group"); return data;
    }
    private Map<String,String> legacy() {
        Map<String,String> data = new HashMap<>(); data.put("user_id", "11"); data.put("conversation_id", "71"); data.put("message_id", "23"); return data;
    }
    @Test public void goUUIDsResolveToLocalConversationAndMessageSequence() {
        Ids ids = new Ids(); PushMessagePolicy.Message m = PushMessagePolicy.decode(go(), true, 11, ids);
        assertNotNull(m); assertEquals(11,m.userId); assertEquals(71,m.conversationId); assertEquals(23,m.messageId);
        assertEquals(CONVERSATION,ids.wire); assertEquals(1,ids.users); assertEquals(1,ids.conversations); assertEquals(0,m.senderId);
    }
    @Test public void anotherRecipientDoesNotCreateAConversationMapping() {
        Map<String,String> data = go(); data.put("user_id", MESSAGE); Ids ids = new Ids();
        assertNull(PushMessagePolicy.decode(data,true,11,ids)); assertEquals(0,ids.conversations);
    }
    @Test public void invalidUUIDFieldsAreRejectedBeforeAnyMapping() {
        for (String field : new String[]{"user_id","conversation_id","message_id"}) {
            for (String bad : new String[]{"11","not-a-uuid","", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}) {
                Map<String,String> data=go(); data.put(field,bad); Ids ids=new Ids();
                assertNull(PushMessagePolicy.decode(data,true,11,ids)); assertEquals(0,ids.users); assertEquals(0,ids.conversations);
            }
        }
    }
    @Test public void goRequiresAllWireIdentitiesAndTheSequence() {
        for (String field : new String[]{"user_id","conversation_id","message_id","seq"}) {
            Map<String,String> data=go(); data.remove(field); Ids ids=new Ids();
            assertNull(PushMessagePolicy.decode(data,true,11,ids)); assertEquals(0,ids.conversations);
        }
    }
    @Test public void sequenceMustBePositiveAndWithinTheExistingUIIntegerRange() {
        for (String bad : new String[]{"0","-1","+1","1.0"," 1","1 ","2147483648","999999999999999999999"}) {
            Map<String,String> data=go(); data.put("seq",bad); Ids ids=new Ids();
            assertNull(PushMessagePolicy.decode(data,true,11,ids)); assertEquals(0,ids.conversations);
        }
        Map<String,String> data=go(); data.put("seq","2147483647");
        assertEquals(Integer.MAX_VALUE,PushMessagePolicy.decode(data,true,11,new Ids()).messageId);
    }
    @Test public void goDoesNotFallBackToUnscopedLegacyIntegerIdentities() {
        assertNull(PushMessagePolicy.decode(legacy(),true,11,new Ids()));
    }
    @Test public void signedOutOrMissingPayloadIsRejectedWithoutReadingMappings() {
        Ids ids=new Ids(); assertNull(PushMessagePolicy.decode(go(),true,0,ids));
        assertNull(PushMessagePolicy.decode(null,true,11,ids)); assertEquals(0,ids.users); assertEquals(0,ids.conversations);
    }
    @Test public void failedLocalMappingIsNeverTurnedIntoAnUnrelatedConversation() {
        Ids ids=new Ids(); ids.local=0; assertNull(PushMessagePolicy.decode(go(),true,11,ids));
    }
    @Test public void mappingExceptionsRemainVisibleToTheAndroidDiagnosticBoundary() {
        assertThrows(IllegalStateException.class,()->PushMessagePolicy.decode(go(),true,11,new Ids(){
            public int conversation(String value){throw new IllegalStateException("fixture storage failure");}
        }));
    }
    @Test public void legacyNumericPayloadKeepsItsPreviousIdentifiers() {
        Map<String,String> data=legacy(); data.put("sender_id","12"); Ids ids=new Ids();
        PushMessagePolicy.Message m=PushMessagePolicy.decode(data,false,11,ids);
        assertEquals(71,m.conversationId); assertEquals(23,m.messageId); assertEquals(12,m.senderId); assertEquals("direct",m.type);
        assertEquals(0,ids.users); assertEquals(0,ids.conversations);
    }
    @Test public void legacyOwnerAndConversationMustBeValidPositiveIntegers() {
        for (String field:new String[]{"user_id","conversation_id"}) {
            for (String bad:new String[]{"0","-1","2147483648","not-a-number"}) {
                Map<String,String> data=legacy(); data.put(field,bad); assertNull(PushMessagePolicy.decode(data,false,11,new Ids()));
            }
        }
        Map<String,String> data=legacy(); data.put("user_id","12"); assertNull(PushMessagePolicy.decode(data,false,11,new Ids()));
    }
    @Test public void legacyMissingMessageAndSenderKeepTheExistingZeroFallback() {
        Map<String,String> data=legacy(); data.remove("message_id");
        PushMessagePolicy.Message m=PushMessagePolicy.decode(data,false,11,new Ids()); assertEquals(0,m.messageId); assertEquals(0,m.senderId);
    }
    @Test public void pushesForDifferentConversationsDoNotShareTheirSequenceIdentity() {
        Ids first=new Ids(),second=new Ids(); second.local=72;
        Map<String,String> other=go(); other.put("conversation_id",MESSAGE);
        PushMessagePolicy.Message a=PushMessagePolicy.decode(go(),true,11,first),b=PushMessagePolicy.decode(other,true,11,second);
        assertEquals(a.messageId,b.messageId); assertNotEquals(a.conversationId,b.conversationId);
    }
    @Test public void mutingAndConversationTypeArePreservedForTheExistingAlertPolicy() {
        for (String type:new String[]{"direct","group","channel"}) {
            Map<String,String> data=go(); data.put("conversation_type",type); data.put("notifications_muted","true");
            PushMessagePolicy.Message m=PushMessagePolicy.decode(data,true,11,new Ids()); assertTrue(m.muted); assertEquals(type,m.type);
        }
    }
    @Test public void unknownTypeCannotBypassTheExistingNotificationCategorySettings() {
        Map<String,String> data=go(); data.put("conversation_type","unknown"); Ids ids=new Ids();
        assertNull(PushMessagePolicy.decode(data,true,11,ids)); assertEquals(0,ids.conversations);
    }
    @Test public void emptyBodyUsesExistingGenericTextAndLongPreviewsAreBounded() {
        assertEquals("收到一条新消息",PushMessagePolicy.decode(go(),true,11,new Ids()).body);
        Map<String,String> data=go(); data.put("body"," "); assertEquals("收到一条新消息",PushMessagePolicy.decode(data,true,11,new Ids()).body);
        data.put("body","x".repeat(700)); assertEquals(512,PushMessagePolicy.decode(data,true,11,new Ids()).body.length());
        data.put("body","收到一张图片"); assertEquals("收到一张图片",PushMessagePolicy.decode(data,true,11,new Ids()).body);
    }
}
