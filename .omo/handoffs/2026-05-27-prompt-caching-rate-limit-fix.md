# Session Handoff — Prompt Caching Fix Unblocks Pilot

**Saved:** 2026-05-27 ~17:45 PT · **By:** Sisyphus orchestrator · **Status:** 🟢 PILOT LIVE on `+573224347117` with prompt caching enabled

This is a **delta** on [`2026-05-27-wa-business-ban-and-newnumber-pending-pair.md`](./2026-05-27-wa-business-ban-and-newnumber-pending-pair.md). Read that first for the WA ban + pair flow context.

---

## 0. TL;DR

1. 🟢 **Tono is fully live** on `+573224347117`. Paired via QR, couriered to Railway tono-mp, smoke-tested end-to-end with successful `register_tecnico` tool call.
2. 🟢 **Anthropic prompt caching enabled** in `tono/src/llm.ts` and `manos/src/llm.ts`. Fresh tokens per call dropped from **21,000 → 350-1,000 (95-98% reduction)**. Rate-limit headroom went from 1.4 calls/min → ~50 calls/min on tier-1.
3. 🟢 **May-26 `register_tecnico` defect concern: CLEARED.** Sonnet 4.5 correctly invokes tools at end of registration flow when not rate-limit-blocked.
4. ⚠️ **Manos-mp not yet redeployed** with the cache fix. Code edit done + typecheck green; needs `railway up --service manos-mp --detach` when next session starts.
5. ⚠️ **Malformed phone JIDs observed** (`+51776468320301`, `+33887895953632`) — Baileys LID-vs-phone parsing artifact. Not blocking, but creates duplicate tecnico rows when the same human pairs with different JID forms. Separate ticket.

---

## 1. The diagnosis (why this happened)

Earlier in the session we hit 429 rate-limit errors during Aidan's test registration. Initial hypothesis was "Sonnet 4.5 doesn't invoke tools" (May-26 defect concern). **That was wrong.** Real root cause was a compound bloat issue.

### Token-size evolution (data from eventos table):

```
April 21  3,777 tokens  Gemini 2.5 Flash baseline
April 27  6,082 tokens  +60%  Gemini→Haiku transition (tokenizer change)
May  8   13,553 tokens  +72%  88cf698 (5 new tools), fe18be7 (14-tool contract), 7cb3b33 (3-case routing)
May 23   18,863 tokens  +33%  6821c9a Gap A.1, 710ea27 Gap A.2, 89eb960 Gap A.3 thinking, 897275a Gap A.4
May 25   20,948 tokens  accumulated polish
May 26  ~21,500 tokens  flat  d648dfc Haiku→Sonnet swap (ZERO content change)
May 28   20,718 tokens  flat
```

**The model swap added 0 tokens.** Haiku and Sonnet sent identical 21k prompts. But:
- **Haiku at 21k tokens: 0 / 132 calls = 0% 429 rate**
- **Sonnet at 21k tokens: 7 / 68 calls = 10% 429 rate**

Sonnet 4.5 has a tighter Anthropic tier-1 ITPM cap (30,000) than Haiku 4.5. Same prompt content, different cap, exposed by the swap.

### Why every registration turn 429'd

The identity-gate ([router.ts:225-253](../../tono/src/router.ts#L225-L253)) forces `identify_user` to be the first tool call of every turn for unregistered phones. When Sonnet sees full conversation history and tries to skip directly to `register_tecnico`, the router refuses with `must_identify_first`. The LLM redoes with `identify_user`. **2 LLM calls × 21k tokens in <10s = 42k tokens / minute → guaranteed 429.**

---

## 2. The fix (what changed)

**Anthropic prompt caching** with cache_control on system prompt + tools block. Per Anthropic's docs:
- Cache reads do NOT count toward ITPM rate limit (zero impact for cached portion)
- Cache writes cost 1.25× (first call only)
- Cache reads cost 0.1× (90% input-token discount)
- 5-min TTL, resets on each hit

### Component-by-component coverage:

| Component | Tokens | Cached? |
|---|---|---|
| System prompt ([tono-system.ts](../../tono/src/prompts/tono-system.ts)) | ~11,272 | ✅ YES |
| Tool schemas ([schemas.ts](../../tools/src/schemas.ts)) | ~3,510 | ✅ YES |
| Extended thinking | ~2,000 | n/a |
| Per-turn context blocks | ~288 | ❌ NO (dynamic) |
| Conversation history | ~1,000 | ❌ NO (sliding) |
| User message | ~50 | ❌ NO |

**~14,800 of 21,000 tokens are now cached.** The rest (user message + dynamic context) is the only thing that counts toward ITPM.

### Code diff:

`tono/src/llm.ts`:
1. `toolsForAnthropic()`: removed `satisfies Anthropic.Tool` narrowing, added `cache_control: { type: "ephemeral" }` on the last tool (marks entire tools block as cached).
2. New `systemForAnthropic()`: returns `[{ type: "text", text: TONO_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]`.
3. Call sites (both THINKING_ENABLED branches): replaced `system: TONO_SYSTEM_PROMPT` with `system: systemForAnthropic()`.

`manos/src/llm.ts`: identical changes for `MANOS_TOOL_DECLARATIONS` + `MANOS_SYSTEM_PROMPT`.

No SDK upgrade needed — `@anthropic-ai/sdk@^0.41.0` already supports `cache_control` on both `Tool` and `TextBlockParam`.

---

## 3. Smoke test results (post-deploy)

Deployment: `railway up --service tono-mp --detach` at 17:24 PT, "Toño is online" at 00:25:19 UTC.

Live LLM calls observed (all on Sonnet 4.5, all post-cache-fix):

```
# 1  llm_call  fresh=1045  out=396  lat=6506ms  tools=register_tecnico   ← cache warm
# 2  llm_call  fresh= 658  out= 40  lat=2684ms  (text)
# 3  llm_call  fresh= 510  out=155  lat=4600ms  tools=find_by_cedula
# 4  llm_call  fresh= 720  out=107  lat=4730ms  (text)
# 5  llm_call  fresh= 402  out=309  lat=8922ms  tools=identify_user
# 6  llm_call  fresh= 352  out= 68  lat=3415ms  (text)
```

- Mean fresh tokens: **~600** (vs pre-fix 21,000 = **97% reduction**)
- Rate-limit headroom: **30,000 / 600 = 50 calls/min** (vs 1.4 calls/min pre-fix = **35× improvement**)
- Zero 429 errors in trace
- `register_tecnico` tool fired successfully → `tecnico_re_registered` event written
- Latency stable: 3-9 sec/call

---

## 4. What's still open

| Item | Why | When |
|---|---|---|
| 🟡 **Redeploy manos-mp** | Code edit done + typecheck green, but the running container is the pre-cache build | Next session: `railway up --service manos-mp --detach` |
| 🟡 **Commit + push the cache fix** | tono/src/llm.ts, manos/src/llm.ts, this handoff are all uncommitted | Next session: review with `git status` + commit on `fix/tono-reject-url-as-document-evidence` branch |
| 🟡 **WA Business ban appeal** for `+573105751757` | Still parked. 3 min on phone. | Whenever Irina opens that phone |
| 🟢 **Banned forensics cleanup** | Only after appeal decided. | Per prior handoff §7 |
| 🟡 **Malformed JID phones in DB** | E.g. `+51776468320301`, `+33887895953632`, `+33887895953632` — Baileys LID/JID parse artifacts when WA sender info is incomplete. Creates duplicate-looking tecnico rows. | Defer to dedicated debugging session — needs Baileys API audit + DB cleanup |
| 🟢 **Slim 11k-token system prompt** | Defer indefinitely. Caching makes the size effectively free (0 ITPM cost). Only reason to slim now would be model-clarity, not budget. | Not urgent |
| 🟢 **Add register_tecnico to PRE_IDENTIFY_TOOLS** | Defer. Caching makes the 2-call-per-registration overhead survivable. Worth ~$0.001 saved per registration. | Not urgent |
| 🟢 **Anthropic tier upgrade** | Not needed. Tier 1 is now sufficient. Tier 2 would still be a future option ($40 spend + 7 day wait for 450k ITPM). | Optional |

---

## 5. Cost impact

Pre-fix: 21,000 tokens × $0.003/1k input = $0.063 per call. Daily cap of $10 → 158 calls/day max.

Post-fix (after first warm-up call in 5-min window):
- Cached portion (14,800 tokens): 14,800 × $0.0003/1k = $0.0044 (90% discount)
- Fresh portion (~600 tokens): 600 × $0.003/1k = $0.0018
- **Total: ~$0.0062 per call** (90% reduction)
- Daily cap of $10 → **~1,600 calls/day** (~10× more headroom)

Cost per registration (5-6 calls) dropped from ~$0.32 → ~$0.035.

---

## 6. Critical paths (for next session)

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- **prd.json**: marketplace/prd.json
- **Live dashboard**: https://dashboard-mp-production-1ef3.up.railway.app (serving correct `wa.me/573224347117` — bundle redeployed by Irina earlier today)
- **Tono WA number**: `+573224347117` (paired + couriered + running with cache)
- **Manos WA number**: `+573222392959` (no change — but code-edited, not redeployed)
- **Branch**: `fix/tono-reject-url-as-document-evidence` (3 uncommitted files at handoff time)
- **Prior handoff**: [`2026-05-27-wa-business-ban-and-newnumber-pending-pair.md`](./2026-05-27-wa-business-ban-and-newnumber-pending-pair.md)

---

## 7. Decisions log (delta)

| Date | Decision | Lock-in |
|---|---|---|
| 2026-05-27 | **Enable Anthropic prompt caching** on system prompt + tools (cache_control: ephemeral). Smallest correct fix for the 429 rate-limit issue, restores production headroom regardless of model. | Strategic — keep |
| 2026-05-27 | **Do NOT slim the 11k system prompt** for now. Caching makes the size effectively free (cache reads are 0 ITPM). Slimming work can be quality-driven, not budget-driven. | Pragmatic |
| 2026-05-27 | **Do NOT add register_tecnico to PRE_IDENTIFY_TOOLS**. 2-call-per-registration is wasteful (~$0.001/turn) but caching makes it survivable. Defer to future cleanup. | Defer |
| 2026-05-27 | **Keep Sonnet 4.5** on both Toño and Manos. Caching makes Sonnet's 30k ITPM tier-1 limit non-binding. No need to revert to Haiku. | Pragmatic |
| 2026-05-27 | **No SDK upgrade required**. `@anthropic-ai/sdk@^0.41.0` already supports `cache_control` on `Tool` and `TextBlockParam`. | Empirical |

---

## 8. Next-session starting prompt (copy-paste)

```
Read this handoff first:
  /Users/irina/AI-driven-OS/autonomous/redin/marketplace/.omo/handoffs/2026-05-27-prompt-caching-rate-limit-fix.md

Then:
  1. git status — confirm tono/src/llm.ts, manos/src/llm.ts, the handoff are uncommitted
  2. Review the diff one more time, then commit on fix/tono-reject-url-as-document-evidence:
     git add tono/src/llm.ts manos/src/llm.ts .omo/handoffs/2026-05-27-prompt-caching-rate-limit-fix.md
     git commit -m "feat(llm): Anthropic prompt caching on system + tools (Tono + Manos)"
     git push irinavelezk fix/tono-reject-url-as-document-evidence
  3. Redeploy manos-mp to bring cache fix into the architect flow:
     railway up --service manos-mp --detach
     sleep 60
     railway logs --service manos-mp --deployment | tail -10
     # expect: "Manos is online" or equivalent
  4. Verify cache behavior on Manos:
     send a test message to the architect WhatsApp +573222392959, observe llm_call prompt_tokens drop similarly

Optional cleanup:
  - Submit WA ban appeal for +573105751757 (still parked, see prior handoff §0)
  - Investigate malformed JID phones (+51776468320301, +33887895953632 etc) — Baileys LID/JID parsing

Strategic constraints (still active):
  - AppSheet REMAINS the main system for OT tracking
  - Only Projector writes to AppSheet
  - No deploy without explicit ask
  - Cost cap $10/day Anthropic (now ~$10/1600 calls effectively)
  - Sonnet 4.5 on both Toño + Manos
  - LID self-loop guard MUST stay in place
  - Caching has 5-min TTL; cache will warm on first message of any new conversation
```

---

## Final note

This is two distinct wins in one session:

1. **Pilot recovered** from yesterday's WA ban event (new number paired, couriered, online).
2. **Production-blocking rate-limit bug fixed** with the smallest correct change — caching. No prompt slim needed, no model revert, no router invariants touched.

The code change is tiny (~20 lines across two files) but the impact is large (35× rate-limit headroom, 90% cost reduction). All thanks to root-cause discipline: the model swap was a red herring; the real cause was bloat across 5 weeks of prompt-additive features, exposed by Sonnet's tighter tier-1 cap. Anthropic caching makes the bloat free.

Buena suerte.
