# Automated featured images

> **Status:** Steps 1–7 of 8 complete. Only the production cutover remains.
> Discord **button clicks** cannot be verified until deployed — Discord cannot
> reach a local server. Rendering and the underlying logic are verified.
> Living document, updated as each step lands.

Generates the hero image for every blog post automatically, previews it in
Discord before publishing, and keeps the dashboard and live site in sync.

---

## 0. Resume here

**Everything below is built and tested locally. NOTHING IS DEPLOYED.** The cron
on Vercel still runs the old code — no images, no `post_date`, and the Publish
button still missing on long-titled posts.

### Blocked on one decision

Which provider runs in production. The code supports both; it is one env var.

| | Cost/month | Trade-off |
|---|---|---|
| **Gemini (Nano Banana)** | ~R16 | Matches the six posts already published exactly. Needs billing enabled on the Google Cloud project behind the existing `GEMINI_API_KEY` |
| **fal (FLUX.2 [pro])** | ~R12 | New signup. Slightly different look from the existing posts |

### Then, to finish (Step 8)

1. Enable billing / create the key for the chosen provider.
2. Set the env vars below on **Vercel** (and Render, if it still serves traffic).
3. Deploy.
4. Verify the Discord buttons for real — the one thing that cannot be tested
   locally, because Discord cannot reach a local server.
5. Generate one post end to end and confirm the charge on the provider dashboard.

### Files changed

| File | Change |
|---|---|
| `src/imageGen.js` | **New.** Provider switch, art direction, generation, Supabase upload, regeneration |
| `scripts/testImageGen.js` | **New.** 22 zero-cost tests |
| `scripts/previewDiscordDraftMessage.js` | **New.** Posts the real draft payload to Discord without generating anything |
| `server.js` | Image on `/api/approve`; new `POST /api/image`; `post_date`; cron mention |
| `src/discordInteractions.js` | Image in `runGenerate`; embed preview; Regenerate button; `publish:id:` fix; `post_date` |
| `src/writer.js` | `formatPostDate()` |
| `src/notify.js` | `mention` option, `allowed_mentions` lockdown |
| `public/dashboard.html` | Card thumbnails, "Generate with AI", `imageDirty` fix |
| `scripts/testWriterParsing.js` | 2 date tests |
| `package.json` | Image suite wired into `npm test` |
| `.env.example` | All new vars documented |

### Running it locally

```bash
npm test                      # 62 tests, zero API cost

# Ports 3000 and 3001 are occupied by other processes on this machine.
PORT=3456 IMAGE_PROVIDER=cloudflare IMAGE_HEIGHT=512 node server.js
# then open http://localhost:3456/dashboard.html

node src/imageGen.js "Some Post Title" tech          # one image, end to end
IMAGE_PROVIDER=stub node src/imageGen.js "Title" tech # offline, instant, free
node scripts/previewDiscordDraftMessage.js <slug>     # re-post a draft to Discord
```

`IMAGE_HEIGHT=512` halves the Cloudflare neuron burn while developing. The free
allocation is roughly **6 images/day** at that size, **3/day** at 16:9.

### Production env vars

Set on Vercel (and Render if it serves traffic). **`IMAGE_PROVIDER` is the
critical one** — it defaults to `cloudflare`, which has no credentials in
production, so forgetting it means posts silently save with no image.

```
IMAGE_PROVIDER=gemini            # or: fal
DISCORD_MENTION_USER_IDS=1332308831816126549
IMAGE_STYLE=photoreal            # optional, this is the default
IMAGE_WIDTH=1024                 # optional
IMAGE_HEIGHT=576                 # optional

GEMINI_API_KEY=...               # if IMAGE_PROVIDER=gemini
FAL_KEY=...                      # if IMAGE_PROVIDER=fal
```

**Do NOT set `CF_ACCOUNT_ID` / `CF_API_TOKEN` in production.** Cloudflare takes
~100s and Vercel's `maxDuration` is 60 — it would time out every run. It is the
development provider only.

Everything else (`ANTHROPIC_API_KEY`, `SUPABASE_*`, `CRON_SECRET`, `DISCORD_*`)
is unchanged.

### Loose ends

- **Nothing is committed to git.** All of the above is uncommitted working-tree
  changes.
- Three drafts created before `formatPostDate()` still have an empty
  `post_date`, so the dashboard will refuse to publish them until a date is
  typed. Any draft generated from now on is fine.
- `melsoft-dashboard/index.html` is dead code — 1,940 lines, referenced by
  nothing, superseded by `public/dashboard.html`. Recommend deleting.
- `scripts/postContentGuards.sql` step 1 has still never been run (outstanding
  from the July incident, unrelated to images).
- A stale `node` process from 2026-08-17 is listening on port 3000 with old code.

---

## 1. Why

Before this, `posts.image` was populated **only** by the manual file picker in
[`public/dashboard.html`](../public/dashboard.html). Every draft was created with
`image = null`, which meant:

- Publishing from Discord (cron → *Generate #N* → *Publish*) always produced a
  post with **no hero image** — the website blog card falls back to a plain
  colour block. The dashboard warns about this before publishing; the Discord
  path had no such guard.
- The one fully-automated route was therefore the one that produced the worst
  output.

Images were being made by hand in the Gemini app, downloaded, and uploaded
through the dashboard — evident from the filenames on all six published posts
(`Gemini_Generated_Image_*.png`).

---

## 2. How it works

```
Cron 09:00 SAST ──> Discord message (3 topics + Generate buttons)
                          │
              [tap "Generate #2"]
                          │
                          ├─ writePost()               (Claude, 30-45s) ─┐ CONCURRENT
                          └─ generateFeaturedImageSafe() (image, 5-100s) ─┘
                          │
                  insert draft WITH image url
                          │
      Discord followup: title + excerpt + IMAGE PREVIEW
                    [Publish] [Regenerate image]
                          │
                     [tap Publish] ──> live at /blog-preview/<slug>
```

### Concurrency is deliberate

Image generation runs **in parallel** with `writePost()`, never after it.
`writePost()` alone takes 30–60s and Vercel's `maxDuration` is 60s
([`vercel.json`](../vercel.json)), so running them in series would turn working
drafts into timeouts. The image prompt derives from the **topic**, not the
finished article, so there is nothing to wait for.

**Accepted trade-off:** if `writePost()` subsequently fails its content gate, the
image is already generated and orphaned in storage. That costs one image and no
correctness. Running in series to avoid it would cost latency on *every*
request.

### Failure is always non-fatal

`generateFeaturedImageSafe()` never rejects. If generation or upload fails the
post still saves, just without a hero — exactly the behaviour that existed
before images were automated. **A written article must never be lost over a
decorative asset.**

`generateFeaturedImage()` (throwing) exists for call sites where the user
explicitly asked for an image and should see the error.

### Storage: why the bytes are copied

Providers return CDN URLs that **expire** — fal's after roughly 7 days. Storing
one directly would silently break every published post's hero a week later. The
bytes are therefore always downloaded and re-uploaded to the existing public
`blog-images` Supabase bucket, under a `generated/` prefix, and it is *that*
permanent URL which is persisted to `posts.image`.

One URL is shared by Discord, the dashboard and the live site — a single source
of truth.

---

## 3. Art direction

The house style is **fixed in code**; only the per-post scene varies. That split
is what keeps a hundred posts looking like one publication rather than a hundred
unrelated images. The model never chooses lighting, palette or composition.

| Layer | Owner | Varies? |
|---|---|---|
| Lighting, palette, lens, composition, negative constraints | Fixed template in [`src/imageGen.js`](../src/imageGen.js) | No |
| The scene / subject | Claude Haiku, one sentence | Per post |

Two styles ship, selected by `IMAGE_STYLE`:

- **`photoreal`** (default) — warm editorial photography in authentic South
  African settings. Matches the six posts already published.
- **`illustration`** — abstract brand art on a plum/navy ground with an orange
  key light. No people at all, so zero face/hand artifact risk.

### Artifact avoidance happens in the brief

The cheapest place to prevent a mangled hand is to never ask for one. The scene
brief given to Haiku forbids close-ups of hands, fingers on keyboards, readable
screens, text, signage and logos — so those never enter the image prompt. The
fixed template repeats the constraints as a backstop.

People are kept at mid-distance, in profile, or seen from behind.

---

## 4. Providers

One env var (`IMAGE_PROVIDER`) switches between them. Everything else — prompt
building, download, upload, URL — is shared.

| Provider | Model | Cost/image | Free tier | Speed | Notes |
|---|---|---|---|---|---|
| `cloudflare` | FLUX.2 [dev] | free | ~10,000 neurons/day ≈ **3–6 images** | ~100s | Development default. Slow but genuinely free |
| `gemini` | Nano Banana | $0.039 | **none** — quota is a hard `0` | fast | Matches the existing published look |
| `fal` | FLUX.2 [pro] | $0.030 | none | 5–15s | Cheapest paid option |
| `stub` | — | free | unlimited | instant | Offline placeholder PNG built with `zlib`. No network. Used by tests |

### Provider quirks worth knowing

- **Cloudflare** FLUX.2 models require `multipart/form-data`, *not* JSON — the
  rest of the Workers AI catalogue takes JSON. Response is base64 in a JSON
  envelope. Auth header is `Bearer`.
- **Gemini** image generation has **no free tier**. A `429` with `limit: 0` means
  billing is not enabled on the project — it is not a rate window to wait out.
  Auth header is `x-goog-api-key`.
- **fal** auth header is `Key <token>`, not `Bearer`.

### Monthly cost at 5 posts/week (~22/month)

| Provider | Images | + Haiku scene briefs | Total |
|---|---|---|---|
| Cloudflare | R0 | ~R0.30 | **~R0.30** |
| fal FLUX.2 [pro] | ~R12 | ~R0.30 | **~R12** |
| Gemini Nano Banana | ~R16 | ~R0.30 | **~R16** |

Supabase storage is effectively free: ~350 KB × 22/month ≈ 7.7 MB/month against
a 1 GB tier.

---

## 5. Configuration

See [`.env.example`](../.env.example) for the full annotated list.

| Var | Default | Purpose |
|---|---|---|
| `IMAGE_PROVIDER` | `cloudflare` | `cloudflare` \| `gemini` \| `fal` \| `stub` |
| `IMAGE_STYLE` | `photoreal` | `photoreal` \| `illustration` |
| `IMAGE_WIDTH` / `IMAGE_HEIGHT` | `1024` / `576` | 16:9 for production |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | — | Token needs **both** Workers AI *Read* and *Edit* |
| `GEMINI_API_KEY` | — | Requires billing enabled for images |
| `FAL_KEY` | — | |

**Development tip:** set `IMAGE_HEIGHT=512`. Workers AI bills per 512×512 tile
per step, so 1024×512 costs two tiles where 1024×576 costs four — doubling how
many free images per day you get while testing, where exact ratio is irrelevant.

---

## 6. Decision log

Decisions that were reversed are kept, with the evidence that changed them.

| Decision | Outcome | Why |
|---|---|---|
| Image model | FLUX.2 → **deferred to Step 8** | Discovering the live blog is entirely Nano Banana made style-matching worth more than the R4/month price gap. Deferred because the provider is one env var |
| Art direction | Illustration → **photoreal** | Recommended illustration before seeing the live site. Six published posts share a coherent photoreal identity that works; overriding it would have been an aesthetic preference beating a working brand |
| Free testing path | **Cloudflare Workers AI** | The only provider with a documented, card-free allocation covering FLUX.2. Gemini's image free tier is `0`; fal's signup credits could not be confirmed on fal's own pricing page |
| Timing | **Parallel with `writePost()`** | Serial would exceed Vercel's 60s ceiling |
| Storage | **Copy into Supabase** | Provider CDN URLs expire (~7 days for fal) |
| Quality gate | **Discord preview + regenerate** | Hand-picking in the Gemini app silently discarded bad generations. Automated, that gate has to be explicit |
| Aspect ratio | **16:9** | The two most recent published heroes are 2752×1536 (1.79). Older ones drift 1.60–1.64 |
| `post_date` | **Generated, not typed** | Left empty it blocked the dashboard's Publish button and silently passed Discord's, which validates nothing — the unattended path was the permissive one |

---

## 7. Verification log

### Step 1 — free provider proven ✅

| Check | Result |
|---|---|
| Cloudflare auth | HTTP 200 |
| FLUX.2 [dev] generation | 1024×512 JPEG, 402 KB, 107s |
| Encoding quirk found | FLUX.2 needs `multipart/form-data` |
| Cost | **R0** |

Also probed Gemini: the key can *see* six image models but generation returns
`429 … limit: 0`. Confirmed no free tier. Cost: R0 (rejected before generating).

### Step 2 — `src/imageGen.js` + art direction ✅

| Check | Result |
|---|---|
| Haiku scene brief | 171 in / 30 out tokens |
| Artifact constraints honoured | No keyboard close-ups, no readable screens, no signage |
| Real generation → upload | 1024×512 JPEG, 321 KB |
| Public URL | HTTP 200, correct content type |
| Stub provider | Valid PNG, no network |
| Existing suites | 25 writer + 13 research still pass |
| Image cost | **R0** |

**Side benefit measured:** 321 KB vs the 6–8 MB PNGs on the live posts — a **~20×
page-weight reduction** per blog visit.

### Step 3 — dashboard generate path ✅

Wired into `POST /api/approve` in [`server.js`](../server.js). Verified end to
end from the dashboard.

| Check | Result |
|---|---|
| Draft saved | `02cec078-…`, status `draft` |
| `posts.image` populated | `.../blog-images/generated/ai-powered-cyber-reconnaissance-…jpg` |
| Image publicly reachable | HTTP 200, `image/jpeg`, 358 KB |
| Ran concurrently with writing | Writer ~45s, image 137.8s, **total 140s** — not 183s |
| Content gate | Passed; 6 min read |
| Image cost | **R0** |

**Latency note:** 140s is Cloudflare, not the design. The writer finishes first;
the image is the long pole. On a production provider the image lands in 5–15s
and the writer becomes the bottleneck again, putting the total back at 30–45s.

#### Side fix: `post_date` is now generated

Verification surfaced a pre-existing gap unrelated to images. Every draft ever
created had an **empty `post_date`**, because nothing populated it — the other
five fields come from database defaults. Consequences:

- The dashboard's Publish button **refuses** to publish without it
  ([`dashboard.html`](../public/dashboard.html) validates six fields), so every
  post needed the date typed by hand.
- Discord's `runPublish()` validates **nothing**, so the automated path would
  have published posts with no date at all — the lax path was the unattended one.
- Hand-typing had already caused format drift: `Aug 11, 2026` on recent posts,
  `29 July` on older ones.

`formatPostDate()` now lives in [`src/writer.js`](../src/writer.js) beside
`generateSlug()` and is applied in **both** write paths. It renders in
`Africa/Johannesburg`, not server-local UTC — otherwise anything generated after
22:00 SAST would be stamped with the previous day. Two regression tests pin both
the format and the timezone behaviour.

Still editable in the dashboard like any other field.

---

### Step 4 — Discord path + image preview ✅ (rendering verified)

Image generation added to `runGenerate()`, running concurrently with
`writePost()` exactly as `/api/approve` does. `editOriginalResponse()` gained an
optional `embeds` argument — attached only when present, so every pre-existing
caller (`/topics`, `/publish`) sends a byte-identical payload to before.

The draft message now carries a full-width image preview above the Publish
button. When no image was produced the message falls back to the original plain
text **plus an explicit warning** that the blog card will show a plain colour
block — the same warning the dashboard has always given and Discord never did.

| Check | Result |
|---|---|
| Discord accepts the payload | HTTP 200 |
| Embed attached | 1 |
| Image rendered by Discord | yes |
| Cost | **R0** (reused an existing draft; nothing generated) |

Verified with [`scripts/previewDiscordDraftMessage.js`](../scripts/previewDiscordDraftMessage.js),
which posts the byte-identical payload via the bot token using the **exported**
`buildDraftEmbeds()` — the same code path the live handler uses, not a copy.
This exists because Discord cannot reach a local server, so the interaction
route itself can only be exercised once deployed.

#### Side fix: the Publish button was silently missing on 39% of posts

Discord caps `custom_id` at 100 characters. The button used `publish:<slug>`,
and slugs here run **68–106 chars** — so on long-titled posts the id breached the
cap and the code dropped the button rather than rendering it. Measured against
the real table: **7 of 18 posts had no Publish button**, with nothing shown to
explain why.

Fixed by referencing the **draft UUID** instead: `publish:id:<uuid>` is always 47
characters and cannot breach the cap. `runPublish()` accepts both forms — the new
`id:` reference, and a bare slug for `/publish <slug>` and any older message
still carrying one.

Two latent bugs were fixed alongside it: the "already published" and "published"
confirmations both built the live URL from the *incoming reference*, which under
the `id:` form is a UUID rather than a slug. Both now read the slug off the row.

### Step 5 — regeneration controls ✅

The preview from Step 4 is only useful if a bad image can be acted on. Two entry
points, one shared implementation.

`regenerateImageForDraft()` lives in [`src/imageGen.js`](../src/imageGen.js) and
is called by **both** the Discord button and `POST /api/image`, so the
drafts-only rule and the variation behaviour cannot drift apart between them.

**Drafts only.** Regenerating a published post would swap the image on the live
website instantly, with no preview and no undo — precisely the review step this
feature exists to provide. The server refuses it; the rule is enforced in the
shared function rather than at each call site.

**Regeneration varies the concept, not just the render.** `describeScene()`
takes a `variation` flag that tells Haiku the previous attempt was rejected and
to choose a different setting, subject and angle. A rejected image is usually a
rejected *idea*; re-rolling the same brief would keep producing variations of the
same wrong picture. Measured on the test draft:

| | Scene |
|---|---|
| Original | "A security **analyst** stands before a **wall of network diagrams**…" |
| Regenerated | "A security **team** in a **boardroom** overlooking the city skyline…" |

**The old image is deliberately kept** in storage rather than deleted. It costs
fractions of a cent, and deleting it would break any page that had already
referenced it.

| Check | Result |
|---|---|
| Published post refused | ✓ `ImageGenerationError`, correct type |
| Nonexistent draft refused | ✓ clean message, no crash |
| Real regeneration | ✓ new scene, new URL, `posts.image` updated |
| `POST /api/image` auth gate | ✓ HTTP 401 without a session |
| Discord message rebuilt in place | ✓ same message, new embed and buttons |
| Regenerate behind the allow-list | ✓ `DISCORD_ALLOWED_USER_IDS`, same as publish |
| Image cost | **R0** |

The Discord button is offered **only when an image exists** — with no image the
useful action is a manual upload, not another roll of the dice. Both buttons
reference the draft UUID (`regenimg:id:<uuid>` = 48 chars), so neither can
breach the custom_id cap.

In the dashboard, a **Generate with AI** button sits beside the existing
uploader. It writes the new URL into `currentUploadedImageUrl`, which is what a
subsequent Save or Publish persists — so regenerating and then saving cannot
blank the image out.

### Step 6 — dashboard hardening ✅

**Card thumbnails.** The drafts and published lists now show the hero on each
card. Previously the list showed title, excerpt, date and read time but never
the image — so with generation automated you could publish a post having never
seen its hero. The list is the one place a bad image is obvious at a glance.

Posts without an image keep the existing tint bar, so cards stay consistent.
The thumbnail uses negative margins to bleed flush to the card edges rather than
the bar's absolute positioning, which at 16:9 would have overlapped the text.

**The stale-image write.** `saveDraftChanges()` and `publishDraft()` both wrote
`image: currentUploadedImageUrl` — a value captured when the draft was *opened*.
If the image changed in between, saving silently reverted it.

This was harmless when the dashboard was the only thing that could set an image.
It stopped being harmless the moment Discord's Regenerate button existed: open a
draft, regenerate from Discord, click Save, and the new image was gone with no
error.

Fixed with an `imageDirty` flag — `image` is written **only when changed in this
session**. Otherwise the field is omitted entirely and the database keeps
whatever is there. `publishDraft()` additionally re-reads the image before its
"no feature image" warning, so it can neither warn about a missing image that
exists nor stay silent about one that does not.

| Check | Result |
|---|---|
| Dashboard inline JS syntax | ✓ 872 lines parse |
| `imageDirty` reset on open | ✓ |
| Set on manual upload | ✓ |
| Set on AI generation | ✓ |
| Save writes `image` only when dirty | ✓ |
| Publish reconciles against the database | ✓ |
| List query selects `image` | ✓ |
| Tint bar retained as fallback | ✓ |
| Cost | **R0** |

### Step 7 — failure paths and tests ✅

**[`scripts/testImageGen.js`](../scripts/testImageGen.js)** — 22 cases, wired into
`npm test`. **Zero API cost and zero network**: every case exercises a pure
function or an error path that fails before any provider, Claude or storage call.

Total suite: **62 tests** (27 writer, 13 research, 22 image).

What the new cases pin:

| Area | Why it matters |
|---|---|
| Content-type detection | The wrong type makes Supabase serve a file browsers refuse to render inline — a silently broken hero on the live site |
| Dimension reading | Undecodable bytes must yield nulls, never throw |
| Art-direction constraints | The negatives are the only thing keeping text, logos and legible screens out of a published image |
| Embed truncation | Discord rejects the whole message with a 400 if title > 256 or description > 400 — losing the draft notification entirely |
| **The custom_id regression** | Asserts every button id stays ≤ 100 chars against the longest real slug (106 chars), and that the slug is never embedded |
| **The safe wrapper never rejects** | The draft-save path depends on this absolutely — if it throws, a successfully written article is lost over a decorative image |
| Missing credentials | Named explicitly in the error rather than failing obscurely mid-request |

#### Fail before spending

Writing the tests exposed a real flaw: `describeScene()` — a billed Claude call —
ran *before* the provider's credentials were checked. Every attempt with a
missing key still cost a request, and produced a scene brief that could never be
rendered.

Credentials are now validated up front from `PROVIDER_REQUIRED_ENV`, before any
spend. The test suite caught this by observing its own `[usage:imagePrompt]` log
line, which is also how we know the suite is genuinely free.

#### Configuration is read at call time

`IMAGE_PROVIDER`, `IMAGE_STYLE`, `IMAGE_WIDTH` and `IMAGE_HEIGHT` moved from
module-level constants to accessor functions. An env change now takes effect
without redeploying this module's import graph — matching how `isAuthorized()`
re-reads its allow-list — and the tests can exercise each provider without
re-importing.

#### Verified degradation

| Scenario | Behaviour |
|---|---|
| Unknown provider | Draft still saves, `image = null`, warning logged |
| Missing credential | Same, and the missing var is named |
| Untitled topic | Same |
| No image on the Discord path | Message falls back to plain text **plus** an explicit warning that the blog card will show a plain colour block |

**Not covered:** a full end-to-end run with a deliberately broken provider,
because it would cost a real post generation. The guarantee rests on the unit
test that `generateFeaturedImageSafe()` never rejects, plus the insert path being
unchanged from before images existed.

---

## 7b. Discord mentions

The daily cron message and failure alerts now @mention the IDs in
`DISCORD_MENTION_USER_IDS`, so unattended events raise a real notification
instead of a message that is easy to miss. Unset means no mention — the original
behaviour.

Replies to a button you just clicked are deliberately **not** mentioned; you are
already looking at them.

**Mentions are locked down.** Every message now sends explicit
`allowed_mentions: { parse: [], users: [...] }`. Without it Discord parses
whatever is in the content — and the cron message contains **model-written topic
titles**, so a title containing `@everyone` would have pinged the entire server
at 09:00 unattended. `@everyone`, `@here` and role mentions are now disabled
outright; only the configured IDs can ping.

---

## 8. Known risks and limitations

- **Cloudflare is slow (~100s).** Fine locally, would exceed Vercel's 60s ceiling.
  Development only; production uses a fast provider.
- **Free allocation is ~3–6 images/day.** Iteration is paced, not instant.
- **The gate checks nothing about image quality.** A well-formed image with a
  six-fingered hand passes every automated check. The Discord preview is the
  only real control — which is why it is not optional.
- **Orphaned images** accumulate in storage when a draft fails its content gate
  after the image was generated. Harmless and cheap; no cleanup job exists.
- **Style parity with the existing library** is not achieved until Step 8, since
  development runs on a different model from production.

---

## 9. Related

- [Incident: model self-review published to the live blog](incident-2026-07-27-published-model-commentary.md)
- [`src/imageGen.js`](../src/imageGen.js)
- [`.env.example`](../.env.example)
