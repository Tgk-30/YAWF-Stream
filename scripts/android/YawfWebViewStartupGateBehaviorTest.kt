package com.tgk30.debridstreamer

private fun checkState(value: Boolean, message: String) { check(value) { message } }

fun main(args: Array<String>) {
  val owner = Any()
  val replacement = Any()
  val gate = YawfWebViewStartupGate()
  checkState(gate.activate(owner, 1), "owned native frame may become active")
  val attempt = gate.begin(owner, 2) ?: error("initial attempt missing")
  when (args.single()) {
    "success-once" -> {
      checkState(!gate.claimHandoff(owner, attempt, 3), "no synchronous Main before actual success")
      checkState(gate.complete(attempt, true, 4), "actual success accepted")
      checkState(gate.claimHandoff(owner, attempt, 5), "active exact owner may hand off once")
      checkState(!gate.claimHandoff(owner, attempt, 6), "duplicate handoff refused")
      checkState(!gate.complete(attempt, true, 7), "duplicate success inert")
    }
    "failure" -> {
      checkState(gate.complete(attempt, false, 4), "actual failure captured")
      checkState(!gate.claimHandoff(owner, attempt, 5), "failure never falls through to Main")
      checkState(gate.begin(owner, 6) == null, "no automatic retry")
    }
    "timeout" -> {
      checkState(gate.tick(20_002) == YawfWebViewStartupGate.Phase.TIMED_OUT, "absolute deadline exact boundary")
      checkState(!gate.complete(attempt, true, 20_003), "late success inert")
      checkState(!gate.claimHandoff(owner, attempt, 20_004), "late success never launches Main")
      checkState(gate.begin(owner, 20_005) == null, "timeout is not an automatic retry")
    }
    "callback-at-deadline" -> {
      checkState(!gate.complete(attempt, true, 20_002), "deadline checked inside callback even if timer is delayed")
      checkState(gate.phase == YawfWebViewStartupGate.Phase.TIMED_OUT, "late callback timed out")
    }
    "inactive" -> {
      gate.deactivate(owner)
      checkState(gate.complete(attempt, true, 4), "warmup may complete without native foreground")
      checkState(!gate.claimHandoff(owner, attempt, 5), "inactive Activity cannot launch")
    }
    "replacement-owner" -> {
      gate.deactivate(owner)
      checkState(gate.activate(replacement, 3), "configuration replacement owns the same in-memory attempt")
      gate.deactivate(owner)
      checkState(gate.owns(replacement), "stale pause cannot clear replacement ownership")
      checkState(gate.complete(attempt, true, 4), "callback updates retained attempt")
      checkState(!gate.claimHandoff(owner, attempt, 5), "destroyed previous owner cannot launch")
      checkState(gate.claimHandoff(replacement, attempt, 6), "replacement may claim once after actual success")
    }
    "resume-after-deadline" -> {
      gate.deactivate(owner)
      gate.complete(attempt, true, 4)
      gate.activate(replacement, 20_003)
      checkState(!gate.claimHandoff(replacement, attempt, 20_004), "background success cannot extend the original deadline")
      checkState(gate.phase == YawfWebViewStartupGate.Phase.TIMED_OUT, "explicit Retry remains required")
    }
    "explicit-retry" -> {
      gate.complete(attempt, false, 3)
      val retried = gate.begin(owner, 4, explicitRetry = true) ?: error("explicit Retry refused")
      checkState(retried != attempt, "Retry has a new attempt identity")
      checkState(!gate.complete(attempt, true, 5), "old callback cannot complete retry")
      checkState(!gate.claimHandoff(owner, attempt, 6), "old callback cannot claim retry")
      checkState(gate.complete(retried, true, 7), "new callback accepted")
      checkState(gate.claimHandoff(owner, retried, 8), "new attempt launches once")
    }
    "retry-while-running" -> {
      checkState(gate.begin(owner, 3, explicitRetry = true) == null, "Retry cannot overlap an in-flight attempt")
      checkState(gate.generation == attempt && gate.deadlineMillis == 20_002L, "no overlapping generation or extended deadline")
    }
    "back-cancel" -> {
      checkState(gate.cancel(owner), "normal Back cancels owned pending admission")
      checkState(!gate.complete(attempt, true, 4), "callback after Back inert")
      checkState(!gate.claimHandoff(owner, attempt, 5), "Back never resurrects Main")
      checkState(!gate.activate(replacement, 6), "cancelled session cannot resurrect on recreation")
    }
    "foreign-owner" -> {
      checkState(gate.begin(replacement, 3, true) == null, "foreign owner cannot retry")
      checkState(!gate.cancel(replacement), "foreign owner cannot cancel")
      gate.complete(attempt, true, 4)
      checkState(!gate.claimHandoff(replacement, attempt, 5), "foreign owner cannot claim")
    }
    "clock-regression" -> {
      checkState(!gate.complete(attempt, true, 1), "backdated outcome refused")
      checkState(!gate.claimHandoff(owner, attempt, 2), "backdated outcome is not progress")
    }
    else -> error("unknown deterministic startup scenario")
  }
  println("Startup policy passed: ${args.single()}")
}
