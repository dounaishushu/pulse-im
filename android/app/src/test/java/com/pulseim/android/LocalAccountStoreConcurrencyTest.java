package com.pulseim.android;

import static org.junit.Assert.*;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class LocalAccountStoreConcurrencyTest {
    @Test public void outerTransactionWaitsForLegacyRecordMonitorBeforeEnteringStore() throws Exception {
        Method transaction = null;
        for (Method method : LocalAccountStore.class.getDeclaredMethods()) {
            if (method.getName().equals("outboxTransaction")) transaction = method;
        }
        assertNotNull(transaction);
        final Method entry = transaction;
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch finished = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            started.countDown();
            try {
                // Null arguments intentionally stop at Kotlin's entry checks. The real method's
                // monitor is acquired first; no Android API, database, token or crypto is touched.
                entry.invoke(LocalAccountStore.INSTANCE, new Object[] {null, null, null});
            } catch (InvocationTargetException e) {
                failure.set(e.getCause());
            } catch (Throwable e) {
                failure.set(e);
            } finally {
                finished.countDown();
            }
        }, "outbox-transaction-monitor-regression");
        worker.setDaemon(true);
        boolean waitingForLegacyMonitor = false;
        try {
            // @JvmStatic legacy read/write methods own this monitor. A transaction must wait
            // here before it can acquire the instance database/key monitor or call legacy write.
            synchronized (LocalAccountStore.class) {
                worker.start();
                assertTrue(started.await(1, TimeUnit.SECONDS));
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (System.nanoTime() < deadline) {
                    if (worker.getState() == Thread.State.BLOCKED) {
                        waitingForLegacyMonitor = true;
                        break;
                    }
                    if (finished.await(5, TimeUnit.MILLISECONDS)) break;
                }
            }
        } finally {
            worker.join(2000);
        }
        assertFalse("Transaction entry must finish after the legacy monitor is released", worker.isAlive());
        assertTrue("Outbox transaction entered while a legacy reader owned the class monitor; "
                + "this permits instance -> class / class -> instance deadlock", waitingForLegacyMonitor);
        assertTrue("Only the deliberate null-argument entry check should fail: " + failure.get(),
                failure.get() instanceof NullPointerException);
    }
}
