package com.pulseim.android;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;

/** One in-flight progress write; newer answers replace queued values, never an in-flight write. */
final class WorkAnswerSync {
    interface Saver { void save(Map<String, Boolean> answers) throws Exception; }
    interface Listener { void completed(Exception error); }
    private final Executor executor;
    private final Saver saver;
    private final BooleanSupplier current;
    private final Listener listener;
    private final Map<String, Boolean> pending = new LinkedHashMap<>();
    private boolean running, paused, closed;

    WorkAnswerSync(Executor executor, Saver saver, BooleanSupplier current, Listener listener) {
        this.executor = executor; this.saver = saver; this.current = current; this.listener = listener;
    }
    synchronized boolean busy() { return running || (!paused && !pending.isEmpty()); }
    synchronized void enqueue(Map<String, Boolean> answers) {
        if (closed) return;
        pending.putAll(answers);
        if (!running && !paused && !pending.isEmpty()) {
            running = true;
            try { executor.execute(this::drain); }
            catch (RuntimeException error) { running = false; throw error; }
        }
    }
    // The final full answer snapshot runs on the same serial executor after the current write.
    synchronized void pauseForSubmission() { paused = true; pending.clear(); }
    synchronized void resume(Map<String, Boolean> answers) { if (!closed) { paused = false; enqueue(answers); } }
    synchronized void close() { closed = true; pending.clear(); }
    private void drain() {
        for (;;) {
            Map<String, Boolean> batch;
            synchronized (this) {
                if (closed || paused || pending.isEmpty() || !current.getAsBoolean()) { running = false; return; }
                batch = new LinkedHashMap<>(pending); pending.clear();
            }
            Exception failure = null;
            try { saver.save(batch); } catch (Exception error) { failure = error; }
            boolean more;
            synchronized (this) {
                if (failure != null && !closed && !paused) {
                    Map<String, Boolean> newer = new LinkedHashMap<>(pending);
                    pending.putAll(batch); pending.putAll(newer);
                }
                more = failure == null && !closed && !paused && !pending.isEmpty();
                if (!more) running = false;
            }
            listener.completed(failure);
            if (!more) return;
        }
    }
}
