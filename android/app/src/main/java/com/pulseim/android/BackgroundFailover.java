package com.pulseim.android;

import java.util.concurrent.Callable;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/** Dispatch only; route validation and the existing executor remain owned by RouteManager. */
final class BackgroundFailover {
    private final Executor executor;
    private final AtomicBoolean busy = new AtomicBoolean();
    BackgroundFailover(Executor executor) { this.executor = executor; }
    boolean request(boolean singleGoRoute, BooleanSupplier switched, Runnable probe) {
        if (singleGoRoute) return false;
        if (switched.getAsBoolean()) return true;
        if (busy.compareAndSet(false, true)) {
            try { executor.execute(() -> { try { probe.run(); } finally { busy.set(false); } }); }
            catch (RuntimeException error) { busy.set(false); throw error; }
        }
        return false;
    }
    static <T> T replay(Exception original, boolean safe, boolean switched, Callable<T> replay) throws Exception {
        if (!safe || !switched) throw original;
        return replay.call();
    }
}
