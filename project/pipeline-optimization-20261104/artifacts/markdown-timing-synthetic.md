# Synthetic Markdown session export — timing contract

> **SYNTHETIC FIXTURE, not a real user session or executed export.** Field names and millisecond semantics are copied from OpenChamber `packages/ui/src/lib/exportSession.ts`; any exact rendering differences remain for native Bun verification.

*generated_at: 2026-11-05T21:00:00.000Z; timezone: UTC; timestamps: UTC ISO-8601*

---

## Assistant — parent session, prompt 1

Выполнены две команды. Это фиктивные timestamps для проверки единиц измерения.

**Tool call timing**

```json
{"session_id":"parent","call_id":"parent-shell-1","name":"shell","status":"completed","started_at":"1970-01-01T00:00:01.000Z","completed_at":"1970-01-01T00:28:47.500Z","observed_end_at":"unavailable","duration_ms":1726500,"duration_source":"persisted_tool_state","duration_final":true,"duration_censored":false,"duration_generated_at":"unavailable","duration_clock_skew_ms":"unavailable","next_tool_started_at":"1970-01-01T00:28:51.000Z","next_tool_start_gap_ms":1730000,"overlaps_next":false}
```

**Tool call timing**

```json
{"session_id":"parent","call_id":"parent-read-2","name":"read","status":"completed","started_at":"1970-01-01T00:28:51.000Z","completed_at":"1970-01-01T00:28:51.025Z","observed_end_at":"unavailable","duration_ms":25,"duration_source":"persisted_tool_state","duration_final":true,"duration_censored":false,"duration_generated_at":"unavailable","duration_clock_skew_ms":"unavailable","next_tool_started_at":"unavailable","next_tool_start_gap_ms":"unavailable","overlaps_next":"unavailable"}
```

## Assistant — child session, prompt 1

Отдельная дочерняя сессия: её время не включается в parent session.

**Tool call timing**

```json
{"session_id":"child","call_id":"child-shell-1","name":"shell","status":"completed","started_at":"1970-01-01T00:00:10.000Z","completed_at":"1970-01-01T00:00:12.000Z","observed_end_at":"unavailable","duration_ms":2000,"duration_source":"persisted_tool_state","duration_final":true,"duration_censored":false,"duration_generated_at":"unavailable","duration_clock_skew_ms":"unavailable","next_tool_started_at":"1970-01-01T00:00:10.500Z","next_tool_start_gap_ms":500,"overlaps_next":true}
```

**Tool call timing**

```json
{"session_id":"child","call_id":"child-read-2","name":"read","status":"completed","started_at":"1970-01-01T00:00:10.500Z","completed_at":"1970-01-01T00:00:10.600Z","observed_end_at":"unavailable","duration_ms":100,"duration_source":"persisted_tool_state","duration_final":true,"duration_censored":false,"duration_generated_at":"unavailable","duration_clock_skew_ms":"unavailable","next_tool_started_at":"unavailable","next_tool_start_gap_ms":"unavailable","overlaps_next":"unavailable"}
```

## Assistant — child session, prompt 2

Повторный prompt той же дочерней сессии.

**Tool call timing**

```json
{"session_id":"child","call_id":"child-read-3","name":"read","status":"pending","started_at":"unavailable","completed_at":"unavailable","observed_end_at":"unavailable","duration_ms":"unavailable","duration_source":"unavailable","duration_final":false,"duration_censored":false,"duration_generated_at":"unavailable","duration_clock_skew_ms":"unavailable","next_tool_started_at":"unavailable","next_tool_start_gap_ms":"unavailable","overlaps_next":"unavailable"}
```

## Interpretation (synthetic)

- Parent shell `duration_ms=1726500` represents 1,726.5 seconds from persisted start/end, not the gap to the next command.
- Parent `next_tool_start_gap_ms=1730000` is the difference between command *starts*. It must not be treated as command execution duration.
- Child `child-shell-1` overlaps `child-read-2` (`next_tool_start_gap_ms=500`, `overlaps_next=true`); the child intervals do not add to parent wall-clock.
- A pending tool has no completed timestamp and no invented zero duration.

Grounded validation evidence: [OpenChamber tool timing](https://github.com/gest0r1/openchamber-ru/blob/feature/pipeline-optimization-20261104/project/pipeline-optimization-20261104/timing-evidence.md). Full Bun export tests still required.
