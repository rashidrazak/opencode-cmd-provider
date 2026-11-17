// src/rates-usage/gui/idle.ts — the desktop panel's completed-turn signal
// (issue #245), split out of panel.tsx so it is executable without a Solid
// owner or the built bundle: the unit tests drive filtering and teardown
// directly, the same way the TUI halves test subscribeV1Idle/subscribeV2Idle.
//
// The contract is the desktop counterpart of subscribeV2Idle: both turn
// events of the session's own server data store wake the refresh policy for
// the watched session, and every other session's events are ignored. The
// caller (panel.tsx) hands in the data object it keyed on via `createKeyed`,
// so a restarted server's fresh store gets a fresh subscription and the old
// one is withdrawn with the generation's owner through the returned
// unsubscribe.
import type { Data } from "@opencode/plugin/gui"

/**
 * Subscribes both turn events on `data`, filtered to `sessionID`, calling
 * `notify` once per completed turn in that session. Returns the teardown that
 * unsubscribes both.
 */
export function subscribeGuiIdle(data: Data, sessionID: string, notify: () => void): () => void {
  const offIdle = data.on("session.idle", (event) => {
    if (event.data.sessionID === sessionID) notify()
  })
  const offSucceeded = data.on("session.execution.succeeded", (event) => {
    if (event.data.sessionID === sessionID) notify()
  })
  return () => {
    offIdle()
    offSucceeded()
  }
}
