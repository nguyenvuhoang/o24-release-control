import assert from 'node:assert/strict'
import test from 'node:test'
import { computeMonitoringRecoveryDelayMs, deriveBuildUpdate } from './useBuildTracker'

// ---- deriveBuildUpdate (previously untested, despite being the core build
// state machine: running -> fast poll, success -> stop, failure -> slow-watch
// window for a possible "Re-run failed jobs") ----

test('deriveBuildUpdate: a queued/in_progress run polls fast and clears any prior slow-watch deadline', () => {
  const update = deriveBuildUpdate({ status: 'in_progress', conclusion: null }, 12345, 1000)
  assert.equal(update.status, 'in_progress')
  assert.equal(update.conclusion, null)
  // 10s, per the "reasonable polling interval for active builds" requirement
  // — was 3s (see FAST_INTERVAL_MS's own comment).
  assert.equal(update.nextDelayMs, 10000)
  assert.equal(update.slowWatchDeadline, undefined)
})

test('deriveBuildUpdate: a successful completion stops polling and clears the slow-watch deadline', () => {
  const update = deriveBuildUpdate({ status: 'completed', conclusion: 'success' }, 12345, 1000)
  assert.equal(update.status, 'success')
  assert.equal(update.nextDelayMs, null)
  assert.equal(update.slowWatchDeadline, undefined)
})

test('deriveBuildUpdate: a failed completion opens a fresh 15-minute slow-watch window when none existed', () => {
  const now = 1_000_000
  const update = deriveBuildUpdate({ status: 'completed', conclusion: 'failure' }, undefined, now)
  assert.equal(update.status, 'failed')
  assert.equal(update.slowWatchDeadline, now + 15 * 60 * 1000)
  assert.ok(update.nextDelayMs !== null && update.nextDelayMs > 0)
})

test('deriveBuildUpdate: a failed completion keeps an EXISTING slow-watch deadline rather than resetting it', () => {
  const existingDeadline = 2_000_000
  const update = deriveBuildUpdate({ status: 'completed', conclusion: 'failure' }, existingDeadline, 1_000_000)
  assert.equal(update.slowWatchDeadline, existingDeadline)
})

test('deriveBuildUpdate: polling stops once the slow-watch window has elapsed', () => {
  const deadline = 1_000_000
  const update = deriveBuildUpdate({ status: 'completed', conclusion: 'failure' }, deadline, deadline + 1)
  assert.equal(update.nextDelayMs, null)
})

test('deriveBuildUpdate: a re-run moving back to in_progress resumes fast polling and clears the old deadline', () => {
  const update = deriveBuildUpdate({ status: 'in_progress', conclusion: null }, 999, 1000)
  assert.equal(update.status, 'in_progress')
  assert.equal(update.slowWatchDeadline, undefined)
})

// ---- computeMonitoringRecoveryDelayMs — the bounded backoff used ONLY once
// MAX_CONSECUTIVE_ERRORS is reached, so a run of transport failures (our own
// API returning 502, a network blip) recovers automatically instead of
// permanently marking the build as failed (HTTP 502 must never automatically
// mean "build failed"). ----

test('computeMonitoringRecoveryDelayMs grows exponentially and is bounded', () => {
  const first = computeMonitoringRecoveryDelayMs(0)
  const second = computeMonitoringRecoveryDelayMs(1)
  const third = computeMonitoringRecoveryDelayMs(2)
  assert.ok(first > 0)
  assert.ok(second > first)
  assert.ok(third >= second)
  // Bounded — never grows without limit, however many consecutive failures.
  const faraway = computeMonitoringRecoveryDelayMs(50)
  assert.ok(faraway <= 60_000)
})

test('computeMonitoringRecoveryDelayMs never returns null — monitoring failures always keep retrying', () => {
  for (const n of [0, 1, 2, 5, 10]) {
    const delay = computeMonitoringRecoveryDelayMs(n)
    assert.equal(typeof delay, 'number')
    assert.ok(delay > 0)
  }
})
