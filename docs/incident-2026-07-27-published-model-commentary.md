# Incident: model self-review published to the live blog

| | |
|---|---|
| **Reported** | 2026-07-27 |
| **Resolved (code deployed)** | 2026-08-01 — commit `741ef97` on `main` |
| **Severity** | High — corrupted content served publicly on melsoftacademy.com |
| **Affected** | Blog post generation (`src/writer.js`) and topic research (`src/research.js`) |
| **Status** | Code fixed and deployed. Two manual follow-ups outstanding (see [Outstanding](#outstanding-actions)). |

---

## 1. What happened

A published post — *"How AI Is Reshaping Cybersecurity Operations in South African Companies"* — rendered the finished article, then continued into the model's own out-loud self-review and **two further drafts** of the same article, including raw JSON keys and a ` ```json ` code fence:

> …becomes a competitive advantage or a vulnerability." }
>
> Wait, let me recount my Melsoft mentions and check for compliance with all rules… Rule 1: Concise, ~550-750 words ✓ … Let me refine: ```json { "title": …, "bodyMarkdown": …

The page was live, publicly readable, and showed **"12 min read"** against a prompt that targets 500–800 words (~3–4 minutes). The body measured roughly **2,335 words**.

**Impact:** reputational only. No data loss, no credential exposure, no service outage.

---

## 2. Root cause

Four independent failures had to line up. Each is described with the code as it was at the time of the incident.

### 2.1 The trigger — a self-contradictory prompt

`claude-haiku-4-5` was called with no extended-thinking channel, so it has nowhere to reason except the output. The prompt demanded reasoning anyway:

- Rule 4: *"Before finalizing your response, **count your own Melsoft mentions** and remove any beyond these two."*
- Rule 6: fact-check every statistic
- Rules 1–13: a compliance checklist

…and then, two lines later, forbade exactly that:

> *"You must respond ONLY with a valid JSON object … Do NOT include markdown code fences, preamble, explanations, or postscript."*

The model complied with the first instruction. Its audit became visible output.

### 2.2 The load-bearing defect — concatenating text blocks

This is the part that turned a prompt-adherence wobble into published garbage, and it was **not** obvious from reading the code.

With the server-side `web_search` tool, the API runs **multiple sampling turns, and each turn emits its own `text` block.** Measured against the live API across three runs:

| Run | Block sequence | Result |
|---|---|---|
| 1 | `server_tool_use → web_search_tool_result → text` | joined text parses |
| 2 | `… → text → server_tool_use → web_search_tool_result → text` | **two text blocks, each a complete JSON object** |
| 3 | same as run 2 | **two text blocks, each a complete JSON object** |

The old code joined every block with `''`:

```js
// src/writer.js (before)
let responseText = response.content
  .filter(block => block.type === 'text')
  .map(block => block.text)
  .join('');
```

For runs 2 and 3 this produced `{...}{...}` — which can never parse:

```
JOINED len=3061: FAILS -> Unexpected non-whitespace character after JSON at position 1532
LAST TEXT BLOCK ONLY len=1529: parses
```

**The last text block parsed cleanly in all three runs.** Interleaved prose is what turned this same defect into publishable text rather than a parse error.

### 2.3 The greedy span

```js
// src/writer.js (before)
const firstBrace = responseText.indexOf('{');
const lastBrace  = responseText.lastIndexOf('}');
responseText = responseText.substring(firstBrace, lastBrace + 1);
```

Written to strip preamble around *one* object. Given three objects, it returned a single substring running from the first object's `{` to the last object's `}` — **keeping every word of commentary in between.**

### 2.4 The leak itself — an unbounded recovery

`JSON.parse` failed, `jsonrepair` failed, and the last-resort extractor ran. Title and meta were bounded by a `nextMarker`; `bodyMarkdown` was not:

```js
const bodyMarkdown = valueBetween('bodyMarkdown', null);   // no boundary
// ...
const boundary  = nextMarker ? raw.indexOf(nextMarker, open + 1) : -1;   // -1
const searchEnd = boundary === -1 ? raw.length : boundary;              // END OF RESPONSE
const close     = raw.lastIndexOf('"', searchEnd - 1);                  // LAST QUOTE ANYWHERE
```

`bodyMarkdown` became everything from draft 1's opening quote to the final quote in the entire response. That is verbatim what was published.

The only validation was truthiness:

```js
if (!title || !bodyMarkdown) return null;
```

A 15,000-character string containing raw JSON keys and the model's inner monologue is truthy.

### 2.5 Why nothing downstream caught it

| Layer | Why it didn't stop this |
|---|---|
| Writer validation | Only two checks (Melsoft count, `SETA-accredited`), both non-blocking `console.warn` |
| `markdownToBlocks` | `case 'code'` deliberately renders fences as paragraphs "so content is never silently lost" — this made the leak human-readable |
| Database insert | No CHECK constraint, no trigger, no length bound. Only the `slug` unique index ever fires |
| Draft review UI | The drafts list selected `id, title, excerpt, …` — **never the body.** Title and excerpt were extracted correctly, so the card looked perfect |
| Publish action | A single `update()` flipping `status`; no content inspection |

Six opportunities, zero checks. The pipeline was `parse → insert → flip a flag → live`, with a review UI that structurally hid the only broken field.

### 2.6 A second latent bug found during the investigation

When interleaved prose is simpler, `jsonrepair` does **not** throw — it wraps the concatenated objects into a JSON **array**:

```
=== ROUTE: jsonrepair (returned an ARRAY) ===
TITLE >>> undefined
BODY  >>> undefined
```

`parsedPost.bodyMarkdown` is then `undefined`, and the old code did:

```js
const cleanBody = (parsedPost.bodyMarkdown || '');   // silently empty
```

Result: a saved, publishable draft with a plausible title and a **completely empty body**, with no error and no warning. Never reported, but it was live.

### 2.7 The same bug in `src/research.js`

Identical pattern — `join('')` plus a greedy `indexOf('[') .. lastIndexOf(']')`. Reproduced:

```
two arrays across two turns
  route  : jsonrepair
  isArray: true | len: 2
   [0] title= undefined | element is array: true
   [1] title= undefined | element is array: true
```

`Array.isArray()` was `true`, so the poisoned batch was returned **and persisted to the `research_cache` row**, then served until the next cron. Symptoms: Discord posting topics named `undefined`, buttons resolving to nothing, and `Invalid topic provided to writePost()` for anyone who tried to generate one.

---

## 3. The fix

Four independent layers. Each is individually sufficient to stop this incident.

### Layer 1 — Source (`src/writer.js`, `src/research.js`)

Schema-constrained decoding via `output_config.format`, so the model **cannot** emit commentary or extra drafts alongside the article.

Verified against the live API before adoption: structured outputs works **alongside the server-side `web_search` tool** on `claude-haiku-4-5`. A deliberate provocation — *"double-check your own work out loud and produce two drafts"* — returned clean, parseable JSON with web search still running.

Degrades gracefully: a 400 mentioning `output_config` drops the parameter for the process and falls through to the parser below.

The rule-4 self-audit instruction was removed; enforcement lives in code, where `melsoftCount` already existed.

### Layer 2 — Parser

- **Block selection** replaces `join('')` — blocks tried individually, newest first, with the concatenation only as a fallback for an object split across a boundary.
- **`extractJsonObjects` / `extractJsonValues`** replace the greedy spans: single-pass, **O(n)**, string- and escape-aware, so braces inside prose or inside a value never affect depth.
- **`lenientExtractPost` bounded** to one object candidate's closing brace.
- **`looksLikePost` shape guard** — rejects arrays and empty bodies, closing §2.6.
- **Tiered strategies** — a clean parse of any draft beats a tolerant guess at a later one.

### Layer 3 — Hard gate

`validatePost()` **throws** before anything reaches Supabase. Checks: word count (300–1,400), title length, and unambiguous contamination signatures (raw JSON keys, ` ```json `, self-review phrasing, `Rule N:` checklists, ✓ ticks, `<cite>`/`<thinking>` tags, body starting with `{`).

Covers both call sites — [`server.js`](../server.js) `/api/approve` and [`src/discordInteractions.js`](../src/discordInteractions.js) `runGenerate`. One clean retry on failure; `max_tokens` truncation counts as a failure.

Against the **real leaked post** it fires **seven independent reasons** — no single signature is load-bearing.

`research.js` throws rather than returning a poisoned batch, so the stale-cache fallback at [`research.js:442-454`](../src/research.js#L442-L454) preserves the good cache instead of overwriting it.

### Layer 4 — Defence in depth

- [`scripts/postContentGuards.sql`](../scripts/postContentGuards.sql) — CHECK constraints (`NOT VALID`, so existing rows don't block them) plus an audit query. **Not applied by default** — see [Outstanding](#outstanding-actions).
- Dashboard drafts list now fetches and displays `read_time`, flagging anything over 6 minutes in orange with a ⚠ and tooltip. The incident's card *had* the answer — "12 min read" — it just never rendered it.

### Visibility

Rejections were previously `console.error` only, invisible on serverless. The incident was found by a human reading the live site.

`notifyDiscord` moved to [`src/notify.js`](../src/notify.js) (re-exported from `server.js` for compatibility) and `notifyFailure` added. Alerts now fire on the draft path, the research path, and the **cron path** — which calls `refreshResearchCache()` directly and would otherwise have failed as a silent 500.

`/api/approve` returns **422 with reasons**, distinct from a genuine save failure.

---

## 4. Verification

| Check | Result |
|---|---|
| `npm test` — writer suite | **25 / 25** |
| `npm test` — research suite | **13 / 13** |
| Real leaked post vs `validatePost` | **Rejected, 7 independent reasons** |
| Adversarial: 40k-brace input | **5ms** (the O(n²) trap, caught in self-review and rewritten) |
| Live end-to-end — `writePost` | **Clean.** 681 words, 4 min read, 24 blocks, 3 web searches, all leak assertions clean |
| Live end-to-end — `fetchRecentCandidates` | **Clean.** 9 valid candidates, 0 invalid, all plain objects |

Both suites are zero-API-cost and pin the specific historical failures: the incident shape, the multi-turn block bug, the empty-post bug, truncation, and 13 gate rejections.

---

## 5. Outstanding actions

### 5.1 Find and remove the contaminated rows — **do this**

Run **step 1 only** of [`scripts/postContentGuards.sql`](../scripts/postContentGuards.sql) in the Supabase SQL editor. It is a read-only `SELECT` that lists affected rows, including the post still live.

Nothing in the deployed fix touches existing rows.

> This SQL was written but **never executed** — there is no Postgres in the development environment, and running DDL against production uninvited was not appropriate. Unlike the JavaScript, it is unverified. If step 1 errors, that is a syntax bug in the file, not a data problem.

### 5.2 The CHECK constraints — **optional**

Steps 2–3 of the same file. Today they catch nothing: every path that writes body content already goes through `validatePost`, and the dashboard writes only title/excerpt/category/author/tint/status — **never** `body` or `raw_markdown`.

They insure against three futures: a new write path, a manual edit in the Supabase table editor, or `validatePost` being weakened later.

**Cost:** a false positive surfaces as a raw Postgres constraint violation ("Failed to save draft" plus a cryptic detail), not the clean 422-with-reasons the app gate gives. Bounds are deliberately generous (500–12,000 chars) and the patterns unambiguous, so this is unlikely — not impossible.

### 5.3 Wire tests into the build — **recommended**

Add `npm test` to the Vercel build command. Both suites are zero-cost and would fail the build on a regression rather than letting it reach the site — the gap that allowed this incident.

---

## 6. What this does *not* cover

Stated plainly so it isn't assumed.

- **The gate checks structure, not truth.** A well-formed 650-word article containing an invented statistic passes every check. The only control there remains web search plus inline attribution, which was not changed.
- **Novel malformed output.** The gate keys on known signatures plus length. Output that is 300–1,400 words and contains none of them could theoretically pass layers 2–4. This is precisely why Layer 1 matters — it stops the model producing such text at all. Combined risk: negligible, not zero.
- **Layer 4 is inactive** until §5.1/§5.2 are run.
- **`markdownToBlocks` still renders fenced code as a paragraph** ([`markdownToBlocks.js:170-174`](../src/markdownToBlocks.js#L170-L174)). Defensible now that the gate catches leaks upstream, but it is what made this one human-readable.

---

## 7. Lessons

1. **A last-resort recovery path must be the most suspicious of its own result, not the least.** The recovery ladder was upside down: each rung got more permissive, and the most permissive rung had zero output validation.
2. **Never instruct a non-thinking model to audit itself and then forbid it from showing the audit.** Those two requirements are incompatible; enforce the constraint in code instead.
3. **Concatenating response text blocks is unsafe whenever server-side tools are enabled.** Each sampling turn emits its own block. This was only discoverable by measuring the live API, not by reading the code.
4. **A review UI that hides the field most likely to be wrong is not a review step.** The drafts list showed a correct title and excerpt over a corrupt body, and `read_time` had flagged the problem all along without ever being displayed.
5. **Warnings nobody reads are not controls.** Every pre-existing check was a `console.warn` on a serverless function.
