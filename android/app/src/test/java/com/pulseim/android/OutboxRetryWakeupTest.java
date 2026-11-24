package com.pulseim.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class OutboxRetryWakeupTest {
    private static final class Clock implements OutboxRetryWakeup.Scheduler {
        long now = 1000, delay; int posts, sends; Runnable pending; boolean reject;
        public void post(Runnable task, long ms) { if (reject) throw new IllegalStateException("stopped"); pending = task; delay = ms; posts++; }
        public void cancel(Runnable task) { if (pending == task) pending = null; }
        OutboxRetryWakeup wakeup() { return new OutboxRetryWakeup(this, () -> now, () -> sends++); }
        void fire() { Runnable task = pending; pending = null; task.run(); }
    }
    @Test public void restoredDeadlineSchedulesWithoutSleeping() {
        Clock c = new Clock(); OutboxRetryWakeup w = c.wakeup(); w.schedule(1200);
        assertEquals(200, c.delay); assertEquals(0, c.sends); c.now = 1200; c.fire(); assertEquals(1, c.sends);
        w.schedule(1500); assertEquals(300, c.delay); assertEquals(2, c.posts);
    }
    @Test public void onlyEarliestDeadlineIsPosted() {
        Clock c = new Clock(); OutboxRetryWakeup w = c.wakeup(); w.schedule(2000); w.schedule(2000); w.schedule(3000);
        assertEquals(1, c.posts); w.schedule(1500); assertEquals(2, c.posts); assertEquals(500, c.delay);
    }
    @Test public void resetCancelsAccountWakeupAndExpiredDeadlineRunsSoon() {
        Clock c = new Clock(); OutboxRetryWakeup w = c.wakeup(); w.schedule(2000); w.reset(); assertNull(c.pending);
        w.schedule(0); assertNull(c.pending); w.schedule(900); assertEquals(1, c.delay); c.fire(); assertEquals(1, c.sends);
    }
    @Test public void failedSchedulingDoesNotLoseLaterWakeup() {
        Clock c = new Clock(); OutboxRetryWakeup w = c.wakeup(); c.reject = true;
        assertThrows(IllegalStateException.class, () -> w.schedule(1200)); c.reject = false;
        w.schedule(1300); assertEquals(300, c.delay); assertEquals(1, c.posts);
    }
}
