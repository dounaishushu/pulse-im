package com.pulseim.android;

/** Persisted per account/namespace. A clock rollback or failed comparison starts a new soak. */
final class OutboxRollout {
    static final long WEEK_MS = 7L * 24 * 60 * 60 * 1000;
    final boolean roomReads, legacyOnly;
    final long dualSince, lastVerifiedAt, lastObservedAt, nextPosition;
    OutboxRollout(boolean roomReads, long dualSince, long lastVerifiedAt, long nextPosition) {
        this(roomReads, dualSince, lastVerifiedAt, lastVerifiedAt, nextPosition);
    }
    OutboxRollout(boolean roomReads, long dualSince, long lastVerifiedAt, long lastObservedAt, long nextPosition) {
        this(roomReads, false, dualSince, lastVerifiedAt, lastObservedAt, nextPosition);
    }
    OutboxRollout(boolean roomReads, boolean legacyOnly, long dualSince, long lastVerifiedAt, long lastObservedAt, long nextPosition) {
        if (dualSince < 0 || lastVerifiedAt < dualSince || lastObservedAt < lastVerifiedAt || nextPosition < 0) throw new IllegalArgumentException("Invalid outbox rollout");
        if (roomReads && legacyOnly) throw new IllegalArgumentException("Conflicting outbox modes");
        this.roomReads = roomReads; this.legacyOnly = legacyOnly; this.dualSince = dualSince;
        this.lastVerifiedAt = lastVerifiedAt; this.lastObservedAt = lastObservedAt; this.nextPosition = nextPosition;
    }
    OutboxRollout verified(long now, long position, boolean same) {
        if (now <= 0) throw new IllegalArgumentException("Invalid verification time");
        if (roomReads && !same) throw new IllegalStateException("待发队列校验失败，请保留本地数据后重试");
        long start = !same || dualSince == 0 || now < lastObservedAt ? now : dualSince;
        return new OutboxRollout(roomReads, legacyOnly, start, now, now, position);
    }
    OutboxRollout observed(long now, long position) {
        if (now <= 0) throw new IllegalArgumentException("Invalid mutation time");
        if (now < lastObservedAt) return new OutboxRollout(roomReads, legacyOnly, now, now, now, position);
        return new OutboxRollout(roomReads, legacyOnly, dualSince, lastVerifiedAt, now, position);
    }
    OutboxRollout cutover(long now, boolean same) {
        OutboxRollout checked = verified(now, nextPosition, same);
        if (legacyOnly || !same || checked.dualSince == 0 || now - checked.dualSince < WEEK_MS) throw new IllegalStateException("待发队列尚未完成一周双写校验");
        return new OutboxRollout(true, checked.dualSince, now, nextPosition);
    }
    OutboxRollout rollback(long now) {
        if (now <= 0) throw new IllegalArgumentException("Invalid rollback time");
        return new OutboxRollout(false, true, now, now, now, nextPosition);
    }
}
