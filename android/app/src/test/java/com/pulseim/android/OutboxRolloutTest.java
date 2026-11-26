package com.pulseim.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class OutboxRolloutTest {
    private OutboxRollout.Time time(long wall, long elapsed) { return new OutboxRollout.Time(wall, elapsed, "boot-1"); }
    private OutboxRollout start() { return new OutboxRollout(false, 0, 0, 0).verified(time(1000, 100), 50, true); }
    @Test public void firstVerifiedDualWriteStartsWeekWithoutEnablingReads() {
        OutboxRollout state = new OutboxRollout(false, 0, 0, 0).verified(time(1000, 100), 50, false);
        assertFalse(state.roomReads); assertEquals(1000, state.dualSince); assertEquals(50, state.nextPosition);
        assertThrows(IllegalStateException.class, () -> state.cutover(time(1000 + OutboxRollout.WEEK_MS, 100 + OutboxRollout.WEEK_MS - 1), true));
    }
    @Test public void wholeWeekAndFreshEqualityAreBothRequiredForExplicitCutover() {
        OutboxRollout state = start(); OutboxRollout.Time week = time(1000 + OutboxRollout.WEEK_MS, 100 + OutboxRollout.WEEK_MS);
        assertThrows(IllegalStateException.class, () -> state.cutover(week, false));
        assertTrue(state.cutover(week, true).roomReads);
        assertFalse(state.observed(week, 51).roomReads);
    }
    @Test public void mismatchRestartsSoakEvenAfterOldWeekHasElapsed() {
        OutboxRollout state = start().verified(time(1000 + OutboxRollout.WEEK_MS, 100 + OutboxRollout.WEEK_MS), 50, false);
        assertEquals(1000 + OutboxRollout.WEEK_MS, state.dualSince);
        assertThrows(IllegalStateException.class, () -> state.cutover(time(2000 + OutboxRollout.WEEK_MS, 200 + OutboxRollout.WEEK_MS), true));
    }
    @Test public void backwardsClockRestartsSoakOnOrdinaryMutationAndVerification() {
        OutboxRollout state = start().observed(time(3000, 300), 51);
        assertEquals(2500, state.verified(time(2500, 250), 51, true).dualSince);
        assertEquals(2500, state.observed(time(2500, 250), 52).dualSince);
    }
    @Test public void persistedRolloutCannotResetWeekOrAutoEnableOnRestart() {
        OutboxRollout before = start().observed(time(3000, 300), 51);
        OutboxRollout restored = new OutboxRollout(before.roomReads, before.legacyOnly, before.dualSince, before.lastVerifiedAt, before.lastObservedAt, before.nextPosition, before.sinceElapsed, before.lastElapsed, before.bootId);
        assertEquals(1000, restored.verified(time(4000, 400), 51, true).dualSince); assertFalse(restored.roomReads);
        assertTrue(restored.cutover(time(1000 + OutboxRollout.WEEK_MS, 100 + OutboxRollout.WEEK_MS), true).roomReads);
    }
    @Test public void rollbackRequiresNewWeekAndRoomCorruptionCannotFallbackSilently() {
        OutboxRollout room = start().cutover(time(1000 + OutboxRollout.WEEK_MS, 100 + OutboxRollout.WEEK_MS), true);
        assertThrows(IllegalStateException.class, () -> room.verified(time(2000 + OutboxRollout.WEEK_MS, 200 + OutboxRollout.WEEK_MS), 50, false));
        OutboxRollout legacy = room.rollback(time(2000 + OutboxRollout.WEEK_MS, 200 + OutboxRollout.WEEK_MS));
        assertFalse(legacy.roomReads); assertEquals(2000 + OutboxRollout.WEEK_MS, legacy.dualSince);
        assertThrows(IllegalStateException.class, () -> legacy.cutover(time(3000 + OutboxRollout.WEEK_MS, 300 + OutboxRollout.WEEK_MS), true));
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
    @Test public void jumpingWallClockForwardByAWeekCannotMakeAnImmediateCutoverEligible() {
        OutboxRollout.Time jump = time(1000 + OutboxRollout.WEEK_MS, 101);
        OutboxRollout state = start().observed(jump, 51);
        assertFalse(state.eligible(jump)); assertEquals(100, state.sinceElapsed);
        assertThrows(IllegalStateException.class, () -> state.cutover(jump, true));
        assertTrue(state.cutover(time(jump.wall, 100 + OutboxRollout.WEEK_MS), true).roomReads);
    }
    @Test public void wallClockRollbackCannotAddMonotonicObservationTime() {
        OutboxRollout state = start().verified(time(500, 101), 50, true);
        assertEquals(100, state.sinceElapsed);
        assertThrows(IllegalStateException.class, () -> state.cutover(time(500, 102), true));
        assertTrue(state.cutover(time(500, 100 + OutboxRollout.WEEK_MS), true).roomReads);
    }
    @Test public void rebootAndMonotonicRollbackConservativelyRestartTheWeek() {
        OutboxRollout state = start();
        OutboxRollout.Time reboot = new OutboxRollout.Time(1000 + OutboxRollout.WEEK_MS, 100 + OutboxRollout.WEEK_MS, "boot-2");
        assertThrows(IllegalStateException.class, () -> state.cutover(reboot, true));
        OutboxRollout restarted = state.verified(reboot, 50, true);
        assertEquals(reboot.elapsed, restarted.sinceElapsed); assertEquals("boot-2", restarted.bootId);
        assertTrue(restarted.cutover(new OutboxRollout.Time(reboot.wall + OutboxRollout.WEEK_MS, reboot.elapsed + OutboxRollout.WEEK_MS, "boot-2"), true).roomReads);
        assertEquals(0, state.verified(time(2000, 0), 50, true).sinceElapsed);
    }
    @Test public void oldWallOnlyMetadataAndMissingBootIdentityNeverQualifyForCutover() {
        OutboxRollout old = new OutboxRollout(false, 1000, 1000, 50);
        OutboxRollout.Time week = time(1000 + OutboxRollout.WEEK_MS, 100 + OutboxRollout.WEEK_MS);
        assertThrows(IllegalStateException.class, () -> old.cutover(week, true));
        assertThrows(IllegalStateException.class, () -> old.cutover(week.wall, true));
        OutboxRollout missing = start().verified(new OutboxRollout.Time(week.wall, week.elapsed, ""), 50, true);
        assertThrows(IllegalStateException.class, () -> missing.cutover(new OutboxRollout.Time(week.wall * 2, week.elapsed * 2, ""), true));
    }
    @Test public void invalidMonotonicMetadataIsRejectedRatherThanEarningAWeek() {
        assertThrows(IllegalArgumentException.class, () -> new OutboxRollout.Time(100, -1, "boot"));
        assertThrows(IllegalArgumentException.class, () -> new OutboxRollout(false, false, 1, 1, 1, 0, 2, 1, "boot"));
        assertThrows(IllegalArgumentException.class, () -> new OutboxRollout(false, false, 1, 1, 1, 0, 0, 0, ""));
    }
}
