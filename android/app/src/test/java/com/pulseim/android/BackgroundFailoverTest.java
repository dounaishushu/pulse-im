package com.pulseim.android;

import org.junit.Test;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

public class BackgroundFailoverTest {
    @Test public void failureReturnsWithin200msWhileProbeCompletesInBackground() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), done = new CountDownLatch(1);
        Thread caller = Thread.currentThread(); AtomicBoolean switched = new AtomicBoolean();
        BackgroundFailover f = new BackgroundFailover(job -> { Thread t = new Thread(job, "fake-route-worker"); t.setDaemon(true); t.start(); });
        IOException original = new IOException("original"); long start = System.nanoTime();
        try {
            boolean changed = f.request(false, switched::get, () -> {
                assertNotSame(caller, Thread.currentThread()); entered.countDown();
                try { assertTrue(release.await(2, TimeUnit.SECONDS)); switched.set(true); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
                finally { done.countDown(); }
            });
            assertSame(original, assertThrows(IOException.class, () -> BackgroundFailover.replay(original, true, changed, () -> "replayed")));
            double millis = (System.nanoTime() - start) / 1_000_000.0;
            assertTrue("failure handling took " + millis + "ms", millis < 200); System.out.println("failure_handling_ms=" + millis);
            assertTrue(entered.await(1, TimeUnit.SECONDS)); assertEquals(1, done.getCount());
        } finally { release.countDown(); }
        assertTrue(done.await(1, TimeUnit.SECONDS)); assertTrue(switched.get());
    }
    @Test public void duplicateFailuresShareOneQueuedProbeAndCanRetryAfterCompletion() {
        ArrayDeque<Runnable> jobs = new ArrayDeque<>(); AtomicInteger probes = new AtomicInteger(); BackgroundFailover f = new BackgroundFailover(jobs::add);
        for (int i = 0; i < 10; i++) assertFalse(f.request(false, () -> false, probes::incrementAndGet));
        assertEquals(1, jobs.size()); assertEquals(0, probes.get()); jobs.remove().run();
        assertFalse(f.request(false, () -> false, probes::incrementAndGet)); assertEquals(1, jobs.size()); assertEquals(1, probes.get());
    }
    @Test public void singleGoRouteNeverProbesOrQueues() {
        ArrayDeque<Runnable> jobs = new ArrayDeque<>(); AtomicInteger probes = new AtomicInteger(); BackgroundFailover f = new BackgroundFailover(jobs::add);
        assertFalse(f.request(true, () -> false, probes::incrementAndGet)); assertTrue(jobs.isEmpty()); assertEquals(0, probes.get());
    }
    @Test public void switchedSafeRequestReplaysOnceAndUnsafeRequestKeepsOriginal() throws Exception {
        ArrayDeque<Runnable> jobs = new ArrayDeque<>(); BackgroundFailover f = new BackgroundFailover(jobs::add);
        boolean switched = f.request(false, () -> true, () -> fail("must not probe again")); IOException original = new IOException("original");
        assertEquals("GET", BackgroundFailover.replay(original, true, switched, () -> "GET"));
        assertEquals("same-request-id", BackgroundFailover.replay(original, true, switched, () -> "same-request-id"));
        assertSame(original, assertThrows(IOException.class, () -> BackgroundFailover.replay(original, false, switched, () -> { fail(); return ""; })));
        AtomicInteger calls = new AtomicInteger(); IOException second = new IOException("replay failed");
        assertSame(second, assertThrows(IOException.class, () -> BackgroundFailover.replay(original, true, switched, () -> { calls.incrementAndGet(); throw second; })));
        assertEquals(1, calls.get()); assertTrue(jobs.isEmpty());
    }
    @Test public void rejectedOrFailedProbeDoesNotLeaveBusySetOrSwallowFailure() {
        ArrayDeque<Runnable> jobs = new ArrayDeque<>(); AtomicInteger submits = new AtomicInteger();
        BackgroundFailover f = new BackgroundFailover(job -> { if (submits.getAndIncrement() == 0) throw new RejectedExecutionException("rejected"); jobs.add(job); });
        assertThrows(RejectedExecutionException.class, () -> f.request(false, () -> false, () -> {}));
        IllegalStateException broken = new IllegalStateException("probe failure"); f.request(false, () -> false, () -> { throw broken; });
        assertSame(broken, assertThrows(IllegalStateException.class, () -> jobs.remove().run()));
        f.request(false, () -> false, () -> {}); assertEquals(1, jobs.size());
    }
}
