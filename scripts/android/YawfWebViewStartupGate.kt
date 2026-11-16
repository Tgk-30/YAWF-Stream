package com.tgk30.debridstreamer

/** Main-thread-only admission policy. It never starts WebView or an Activity itself. */
internal class YawfWebViewStartupGate(private val timeoutMillis: Long = 20_000L) {
  enum class Phase { IDLE, WARMING, READY, FAILED, TIMED_OUT, HANDED_OFF, CANCELLED }

  var phase = Phase.IDLE
    private set
  var generation = 0L
    private set
  var deadlineMillis = 0L
    private set
  private var activeOwner: Any? = null
  private var lastMillis = 0L

  init { require(timeoutMillis in 1L..60_000L) }

  fun activate(owner: Any, nowMillis: Long): Boolean {
    if (!observe(nowMillis) || phase == Phase.CANCELLED || phase == Phase.HANDED_OFF) return false
    activeOwner = owner
    expire(nowMillis)
    return true
  }

  fun deactivate(owner: Any) {
    if (activeOwner === owner) activeOwner = null
  }

  fun owns(owner: Any): Boolean = activeOwner === owner

  /** Only IDLE or a deliberate Retry after an error may create another attempt. */
  fun begin(owner: Any, nowMillis: Long, explicitRetry: Boolean = false): Long? {
    if (activeOwner !== owner || !observe(nowMillis)) return null
    val allowed = phase == Phase.IDLE ||
      (explicitRetry && (phase == Phase.FAILED || phase == Phase.TIMED_OUT))
    if (!allowed || nowMillis > Long.MAX_VALUE - timeoutMillis || generation == Long.MAX_VALUE) return null
    generation += 1
    deadlineMillis = nowMillis + timeoutMillis
    phase = Phase.WARMING
    return generation
  }

  /** The actual async outcome is mandatory. Duplicate and previous-generation outcomes are inert. */
  fun complete(attempt: Long, succeeded: Boolean, nowMillis: Long): Boolean {
    if (attempt != generation || phase != Phase.WARMING || !observe(nowMillis)) return false
    if (expire(nowMillis)) return false
    phase = if (succeeded) Phase.READY else Phase.FAILED
    return true
  }

  fun tick(nowMillis: Long): Phase {
    if (observe(nowMillis)) expire(nowMillis)
    return phase
  }

  /** Call from a successful async outcome only, after checking the live native owner. */
  fun claimHandoff(owner: Any, attempt: Long, nowMillis: Long): Boolean {
    if (activeOwner !== owner || attempt != generation || phase != Phase.READY || !observe(nowMillis)) return false
    if (expire(nowMillis)) return false
    phase = Phase.HANDED_OFF
    activeOwner = null
    return true
  }

  fun failPending(owner: Any, attempt: Long, nowMillis: Long): Boolean {
    if (activeOwner !== owner || attempt != generation || !observe(nowMillis)) return false
    if (phase != Phase.WARMING && phase != Phase.READY) return false
    phase = Phase.FAILED
    return true
  }

  fun cancel(owner: Any): Boolean {
    if (activeOwner !== owner || phase == Phase.HANDED_OFF || phase == Phase.CANCELLED) return false
    phase = Phase.CANCELLED
    activeOwner = null
    return true
  }

  private fun expire(nowMillis: Long): Boolean {
    if ((phase == Phase.WARMING || phase == Phase.READY) && nowMillis >= deadlineMillis) {
      phase = Phase.TIMED_OUT
      return true
    }
    return false
  }

  private fun observe(nowMillis: Long): Boolean {
    if (nowMillis < lastMillis || nowMillis < 0L) return false
    lastMillis = nowMillis
    return true
  }
}
