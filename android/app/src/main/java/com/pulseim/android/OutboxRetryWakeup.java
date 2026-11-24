package com.pulseim.android;

import java.util.function.LongSupplier;

/** One earliest wakeup, owned and called by the existing UI scheduling lane. */
final class OutboxRetryWakeup {
    interface Scheduler { void post(Runnable task, long delayMs); void cancel(Runnable task); }
    private final Scheduler scheduler;
    private final LongSupplier clock;
    private final Runnable task;
    private long atMs;
    OutboxRetryWakeup(Scheduler scheduler, LongSupplier clock, Runnable ready) {
        this.scheduler = scheduler; this.clock = clock;
        task = () -> { atMs = 0; ready.run(); };
    }
    void schedule(long deadline) {
        if (deadline <= 0 || (atMs > 0 && atMs <= deadline)) return;
        scheduler.cancel(task); atMs = deadline;
        try { scheduler.post(task, Math.max(1, deadline - clock.getAsLong())); }
        catch (RuntimeException error) { atMs = 0; throw error; }
    }
    void reset() { scheduler.cancel(task); atMs = 0; }
}
