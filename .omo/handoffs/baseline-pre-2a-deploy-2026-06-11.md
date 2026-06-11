# Baseline — pre-Step-2a deploy (upload-ack fix)

**Saved:** 2026-06-11 · **By:** Sisyphus · **Source:** production Supabase via Management API `/database/query` (read-only) · **Scope:** all-time `turns` table (Toño live since 2026-05-28)

Purpose: numbers the 2a deploy (structured `upload_documento` acks + silent-drop fallback) is supposed to move. Re-run these same queries ~1 week post-deploy and diff.

---

## Q1 — Upload-ack misses (S2-H1)

Turns where `upload_documento` succeeded but the outbound reply never says "recib…" (i.e. the worker was not clearly told the document arrived).

```sql
select
  count(*)::int as upload_turns,
  count(*) filter (where outbound_text is null or outbound_text not ilike '%recib%')::int as missing_named_ack,
  count(*) filter (where errors @> '[{"code":"empty_reply_substituted"}]'::jsonb)::int as empty_reply_substituted
from turns
where tool_calls @> '[{"name":"upload_documento","result_ok":true}]'::jsonb;
```

| upload_turns | missing_named_ack | empty_reply_substituted |
|---|---|---|
| 44 | 1 | 0 |

**Read:** 1/44 (2.3%) successful uploads got no "recibí" ack. Low — the prompt mostly carries this today; the fix makes it deterministic (and adds doc-type naming, which this query does NOT measure: "recibí las dos" without naming the doc counts as a pass here).

**Post-deploy target:** 0 missing; bonus check — % of upload turns whose outbound names the doc type (`%cédula%|%ARL%|%EPS%|%constancia%|%certificado%`).

## Q2 — Photo turns without an upload call (S2-H2 silent drops + unsolicited photos)

```sql
select
  count(*)::int as foto_marker_turns,
  count(*) filter (where tool_calls is null
    or not tool_calls @> '[{"name":"upload_documento"}]'::jsonb)::int as foto_turns_without_upload_call
from turns
where inbound_text like '%[foto]%' or inbound_text like '%[documento:%';
```

| foto_marker_turns | foto_turns_without_upload_call |
|---|---|
| 56 | 13 |

**Read:** 13/56 (23%) of photo-marker turns produced no `upload_documento` call. This bucket mixes three causes that are indistinguishable pre-deploy: (a) silent media drops (the bug), (b) legitimate "foto no solicitada" refusals per prompt rule, (c) LLM negligence. **Caveats:** captioned photos don't contain `[foto]` in `inbound_text` (caption replaces it), so this undercounts photo turns overall; `[MEDIA_RECEIVED]` context lines are not part of `inbound_text`.

**Post-deploy:** silent drops become explicitly countable — `inbound_text`/context carrying `[MEDIA_FAILED` markers + delivery-layer fallback sends. This 13 should decompose into measurable buckets.

## Q3 — Duplicate consecutive outbound (S1-H3 trust glitches)

```sql
with seq as (
  select session_id, turn_number, outbound_text,
         lag(outbound_text) over (partition by session_id order by turn_number) as prev_text
  from turns
  where outbound_text is not null
)
select count(*)::int as duplicate_consecutive_outbound,
       count(distinct session_id)::int as sessions_affected
from seq
where outbound_text = prev_text;
```

| duplicate_consecutive_outbound | sessions_affected |
|---|---|
| 4 | 3 |

**Read:** 4 verbatim back-to-back duplicate replies across 3 sessions at the `turns` level. Note: transcript-visible dupes (May28-irina photo-ask ×2, May28-julian ×2) can also originate in the outbound/delivery layer (same turn row sent twice), which this query can't see — `turns`-level dupes are the lower bound. Not addressed by 2a; tracked as the S1-H3 reliability signal.

## Q4 — Turn latency by ReAct iterations (Report-2 baseline; untouched by 2a)

```sql
select
  coalesce(llm_iterations, -1) as llm_iterations,
  count(*)::int as n,
  round(percentile_cont(0.5) within group (order by latency_ms))::int as p50_ms,
  round(percentile_cont(0.95) within group (order by latency_ms))::int as p95_ms,
  round(avg(latency_ms))::int as avg_ms
from turns
where latency_ms is not null
group by 1
order by 1;
```

| llm_iterations | n | p50_ms | p95_ms | avg_ms |
|---|---|---|---|---|
| 0 (no tool calls) | 322 | 7,504 | 13,658 | 8,047 |
| 1 | 137 | 14,126 | 34,966 | 15,784 |
| 2 | 3 | 18,637 | 24,251 | 19,464 |
| 3 | 22 | 17,920 | 26,521 | 18,707 |

**Read:** confirms Report-2 H1 — each tool iteration ≈ +6-7s at p50 (one extra thinking-enabled Claude round-trip). Even zero-tool turns sit at 7.5s p50 (thinking call + ~2s WA debounce + pre-LLM DB chatter). p95 on 1-iteration turns is 35s. This is the latency baseline for the separate latency exercise; 2a must NOT regress it (its only additions: 1-2 cheap `documentos` count queries inside upload turns).

---

**Method:** queries executed via `POST https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query` (same mechanism as `scripts/run-migration.ts`), read-only SELECTs, no writes, no deploys.
