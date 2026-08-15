# Performance budget (A7.5)

Explicit targets for the flows a public, impatient audience feels. **These are targets, set now.**
**Actuals are measured in A11** (real devices + a deployed pipeline) — this doc is the yardstick they're
held to, not a claim they're met.

Measurement method (A11): server timings from the structured logs (`traceId` spans each hop); client
timings from OS signals (iOS `MetricKit` / signposts, web `PerformanceObserver` / Web Vitals). Report p50
and p95; a release gate fails if p95 regresses past the ceiling.

## Pipeline latency (server)

| Metric | Definition | Target p50 | Target p95 (ceiling) |
|---|---|---|---|
| Time to first transcript | upload complete → first transcript line visible | 20 s | 60 s |
| Time to summary (10-min rec) | upload complete → note `ready` | 60 s | 150 s |
| **Time to summary (60-min rec)** | upload complete → note `ready` | **4 min** | **8 min** |
| Notification latency | note `ready` → push delivered | 5 s | 20 s |

## Client responsiveness

| Metric | Definition | Target p50 | Target p95 (ceiling) |
|---|---|---|---|
| iOS cold start | launch → home interactive | 1.2 s | 2.0 s |
| Web cold start (LCP) | navigation → largest contentful paint | 1.8 s | 2.5 s |
| Recording start latency | tap record → capturing (mic granted) | 300 ms | 800 ms |
| Note-open latency (cached) | tap note → content visible | 250 ms | 800 ms |
| Note-open latency (cold fetch) | tap note → content visible | 700 ms | 1.5 s |
| Upload start latency | recording saved → first bytes leaving | 1 s | 3 s |

## Reliability targets (tie to A7.1–A7.4)

| Metric | Target |
|---|---|
| Crash-free sessions (halts rollout below) | ≥ 99.5% |
| Recording recovery success (airplane-mode → relaunch → recovered) | 100% (no silent loss) |
| Upload success within 24 h on flaky mobile data | ≥ 99% |
| DLQ non-empty | alert immediately; target steady-state 0 |
| Pipeline failure rate (per note) | < 1% |

## Cost budget (A9.4 — gates pricing, needs A11 measurement)

Before pricing is fixed, report a **measured blended cost per minute** across STT + Gemini + storage.
The 1,500-minute Pro tier at A$29 only works if this is **well under one cent per minute**
(1500 min × A$0.01 = A$15 COGS vs ~A$24.65 net). **Not yet measured** — blocked on a deployed pipeline
(A11); flagged in BLOCKERS. The §4.6 daily spend circuit breaker (staging A$20 / prod A$200) is the
backstop until the real number is known.
