package com.pulseim.android;

/** Wall timestamps are diagnostic only; the soak requires monotonic time from the same boot. */
final class OutboxRollout {
    static final long WEEK_MS = 7L * 24 * 60 * 60 * 1000;
    static final class Time {
        final long wall, elapsed;
        final String boot;
        Time(long wall, long elapsed, String boot) {
            if (wall <= 0 || elapsed < 0 || boot == null || boot.length() > 128) throw new IllegalArgumentException("Invalid outbox clock");
            this.wall = wall; this.elapsed = elapsed; this.boot = boot;
        }
    }
    final boolean roomReads, legacyOnly;
    final long dualSince, lastVerifiedAt, lastObservedAt, nextPosition;
    final long sinceElapsed, lastElapsed;
    final String bootId;
    OutboxRollout(boolean roomReads, long dualSince, long lastVerifiedAt, long nextPosition) {
        this(roomReads, dualSince, lastVerifiedAt, lastVerifiedAt, nextPosition);
    }
    OutboxRollout(boolean roomReads, long dualSince, long lastVerifiedAt, long lastObservedAt, long nextPosition) {
        this(roomReads, false, dualSince, lastVerifiedAt, lastObservedAt, nextPosition);
    }
    OutboxRollout(boolean roomReads, boolean legacyOnly, long dualSince, long lastVerifiedAt, long lastObservedAt, long nextPosition) {
        this(roomReads, legacyOnly, dualSince, lastVerifiedAt, lastObservedAt, nextPosition, -1, -1, "");
    }
    OutboxRollout(boolean roomReads, boolean legacyOnly, long dualSince, long lastVerifiedAt, long lastObservedAt, long nextPosition,
                  long sinceElapsed, long lastElapsed, String bootId) {
        if (dualSince < 0 || lastVerifiedAt < dualSince || lastObservedAt < lastVerifiedAt || nextPosition < 0) throw new IllegalArgumentException("Invalid outbox rollout");
        if (roomReads && legacyOnly) throw new IllegalArgumentException("Conflicting outbox modes");
        if (bootId == null || bootId.length() > 128 || (bootId.isEmpty() ? sinceElapsed != -1 || lastElapsed != -1 : sinceElapsed < 0 || lastElapsed < sinceElapsed)) throw new IllegalArgumentException("Invalid outbox monotonic metadata");
        this.roomReads = roomReads; this.legacyOnly = legacyOnly; this.dualSince = dualSince;
        this.lastVerifiedAt = lastVerifiedAt; this.lastObservedAt = lastObservedAt; this.nextPosition = nextPosition;
        this.sinceElapsed = sinceElapsed; this.lastElapsed = lastElapsed; this.bootId = bootId;
    }
    // Preserve the original API, but wall-only callers cannot supply observation evidence.
    OutboxRollout verified(long now, long position, boolean same) {
        return verified(new Time(now, 0, ""), position, same);
    }
    OutboxRollout verified(Time now, long position, boolean same) {
        if (roomReads && !same) throw new IllegalStateException("待发队列校验失败，请保留本地数据后重试");
        boolean reset = !same || dualSince == 0 || !continuous(now);
        return state(roomReads, legacyOnly, reset ? now.wall : Math.min(dualSince, now.wall), now.wall, now, position, reset);
    }
    OutboxRollout observed(long now, long position) {
        return observed(new Time(now, 0, ""), position);
    }
    OutboxRollout observed(Time now, long position) {
        boolean reset = dualSince == 0 || !continuous(now);
        return state(roomReads, legacyOnly, reset ? now.wall : Math.min(dualSince, now.wall),
            reset ? now.wall : Math.min(lastVerifiedAt, now.wall), now, position, reset);
    }
    private boolean continuous(Time now) {
        return !bootId.isEmpty() && bootId.equals(now.boot) && now.elapsed >= lastElapsed;
    }
    boolean eligible(Time now) {
        return !legacyOnly && dualSince > 0 && continuous(now) && now.elapsed - sinceElapsed >= WEEK_MS;
    }
    private OutboxRollout state(boolean room, boolean legacy, long start, long verified, Time now, long position, boolean reset) {
        return new OutboxRollout(room, legacy, start, verified, now.wall, position,
            now.boot.isEmpty() ? -1 : reset ? now.elapsed : sinceElapsed, now.boot.isEmpty() ? -1 : now.elapsed, now.boot);
    }
    OutboxRollout cutover(long now, boolean same) {
        return cutover(new Time(now, 0, ""), same);
    }
    OutboxRollout cutover(Time now, boolean same) {
        OutboxRollout checked = verified(now, nextPosition, same);
        if (!same || !checked.eligible(now)) throw new IllegalStateException("待发队列尚未完成一周双写校验");
        return checked.state(true, false, checked.dualSince, now.wall, now, nextPosition, false);
    }
    OutboxRollout rollback(long now) {
        return rollback(new Time(now, 0, ""));
    }
    OutboxRollout rollback(Time now) {
        return state(false, true, now.wall, now.wall, now, nextPosition, true);
    }
}
