package com.pulseim.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class OutboxRolloutTest {
    @Test public void firstVerifiedDualWriteStartsWeekWithoutEnablingReads() {
        OutboxRollout state = new OutboxRollout(false, 0, 0, 0).verified(1000, 50, false);
        assertFalse(state.roomReads); assertEquals(1000, state.dualSince); assertEquals(50, state.nextPosition);
        assertThrows(IllegalStateException.class, () -> state.cutover(1000 + OutboxRollout.WEEK_MS - 1, true));
    }
    @Test public void wholeWeekAndFreshEqualityAreBothRequiredForExplicitCutover() {
        OutboxRollout state = new OutboxRollout(false, 1000, 1000, 50);
        assertThrows(IllegalStateException.class, () -> state.cutover(1000 + OutboxRollout.WEEK_MS, false));
        assertTrue(state.cutover(1000 + OutboxRollout.WEEK_MS, true).roomReads);
        assertFalse(state.observed(1000 + OutboxRollout.WEEK_MS, 51).roomReads);
    }
    @Test public void mismatchRestartsSoakEvenAfterOldWeekHasElapsed() {
        OutboxRollout state = new OutboxRollout(false, 1000, 1000, 50).verified(1000 + OutboxRollout.WEEK_MS, 50, false);
        assertEquals(1000 + OutboxRollout.WEEK_MS, state.dualSince);
        assertThrows(IllegalStateException.class, () -> state.cutover(2000 + OutboxRollout.WEEK_MS, true));
    }
    @Test public void backwardsClockRestartsSoakOnOrdinaryMutationAndVerification() {
        OutboxRollout state = new OutboxRollout(false, 1000, 2000, 50).observed(3000, 51);
        assertEquals(2500, state.verified(2500, 51, true).dualSince);
        assertEquals(2500, state.observed(2500, 52).dualSince);
    }
    @Test public void persistedRolloutCannotResetWeekOrAutoEnableOnRestart() {
        OutboxRollout before = new OutboxRollout(false, 1000, 2000, 50).observed(3000, 51);
        OutboxRollout restored = new OutboxRollout(before.roomReads, before.dualSince, before.lastVerifiedAt, before.lastObservedAt, before.nextPosition);
        assertEquals(1000, restored.verified(4000, 51, true).dualSince); assertFalse(restored.roomReads);
    }
    @Test public void rollbackRequiresNewWeekAndRoomCorruptionCannotFallbackSilently() {
        OutboxRollout room = new OutboxRollout(true, 1000, 1000 + OutboxRollout.WEEK_MS, 50);
        assertThrows(IllegalStateException.class, () -> room.verified(2000 + OutboxRollout.WEEK_MS, 50, false));
        OutboxRollout legacy = room.rollback(2000 + OutboxRollout.WEEK_MS);
        assertFalse(legacy.roomReads); assertEquals(2000 + OutboxRollout.WEEK_MS, legacy.dualSince);
        assertThrows(IllegalStateException.class, () -> legacy.cutover(3000 + OutboxRollout.WEEK_MS, true));
    }
    @Test public void invalidMetadataAndTimeFailClosed() {
        assertThrows(IllegalArgumentException.class, () -> new OutboxRollout(false, 2, 1, 0));
        assertThrows(IllegalArgumentException.class, () -> new OutboxRollout(false, 0, 0, -1));
        OutboxRollout empty = new OutboxRollout(false, 0, 0, 0);
        assertThrows(IllegalArgumentException.class, () -> empty.verified(0, 0, true));
        assertThrows(IllegalArgumentException.class, () -> empty.observed(0, 0));
        assertThrows(IllegalArgumentException.class, () -> empty.rollback(-1));
    }
    @Test public void rollbackDisablesShadowAndCannotCutOverWithoutRestartingDualWrite() {
        OutboxRollout legacy = new OutboxRollout(false, 1000, 1000, 0).rollback(2000);
        assertTrue(legacy.legacyOnly); assertTrue(legacy.observed(3000, 0).legacyOnly);
        assertThrows(IllegalStateException.class, () -> legacy.cutover(3000 + OutboxRollout.WEEK_MS, true));
        assertThrows(IllegalArgumentException.class, () -> new OutboxRollout(true, true, 1, 1, 1, 0));
    }
}
