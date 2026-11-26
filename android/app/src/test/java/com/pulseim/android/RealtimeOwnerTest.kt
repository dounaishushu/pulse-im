package com.pulseim.android

import org.junit.Assert.*
import org.junit.Test

class RealtimeOwnerTest {
    @Test fun firstActivityIsTheOnlyAllowedConnectionOwner() {
        val state = RealtimeOwner<Any>()
        val activity = Any()
        assertFalse(state.owns(activity))
        assertNull(state.claim(activity))
        assertTrue(state.owns(activity))
        assertFalse(state.owns(Any()))
    }

    @Test fun resumingTheSameActivityKeepsItsBackgroundConnection() {
        val state = RealtimeOwner<Any>()
        val activity = Any()
        state.claim(activity)
        assertTrue(state.owns(activity))
        assertNull(state.claim(activity))
        assertTrue(state.owns(activity))
    }

    @Test fun replacementReturnsTheConnectionToCloseAndRejectsOldReconnects() {
        val state = RealtimeOwner<Any>()
        val first = Any(); val second = Any(); val third = Any()
        state.claim(first)
        assertSame(first, state.claim(second))
        assertSame(second, state.claim(third))
        assertFalse(state.owns(first))
        assertFalse(state.owns(second))
        assertTrue(state.owns(third))
    }

    @Test fun destroyingAStoppedActivityDoesNotReleaseTheCurrentConnection() {
        val state = RealtimeOwner<Any>()
        val stopped = Any(); val current = Any()
        state.claim(stopped); state.claim(current)
        state.release(stopped)
        assertTrue(state.owns(current))
        assertFalse(state.owns(stopped))
    }

    @Test fun returningFromANestedChatRestoresTheParentAsOwner() {
        val state = RealtimeOwner<Any>()
        val parent = Any(); val child = Any()
        state.claim(parent); state.claim(child)
        assertSame(child, state.claim(parent))
        state.release(child)
        assertTrue(state.owns(parent))
        assertFalse(state.owns(child))
    }

    @Test fun destroyingTheOwnerAllowsAFreshActivityConnection() {
        val state = RealtimeOwner<Any>()
        val old = Any(); val fresh = Any()
        state.claim(old); state.release(old)
        assertFalse(state.owns(old))
        assertNull(state.claim(fresh))
        assertTrue(state.owns(fresh))
    }

    @Test fun ownershipUsesInstanceIdentityEvenWhenOwnersCompareEqual() {
        data class Owner(val account: String)
        val state = RealtimeOwner<Owner>()
        val old = Owner("same-account"); val replacement = Owner("same-account")
        state.claim(old)
        assertSame(old, state.claim(replacement))
        state.release(old)
        assertFalse(state.owns(old))
        assertTrue(state.owns(replacement))
    }
}
