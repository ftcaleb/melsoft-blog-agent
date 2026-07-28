-- ---------------------------------------------------------------------------
-- Database backstop for the published-commentary incident.
--
-- The application-level gate (validatePost() in src/writer.js) is the primary
-- defence and runs before any insert. This file is defence in depth: it makes
-- the `posts` table itself refuse content carrying the model's own scaffolding,
-- so no future code path — a new script, a manual insert, a direct Supabase
-- edit — can reintroduce the failure.
--
-- Run in the Supabase SQL editor. Safe to run once; re-running errors with
-- "constraint already exists", which is harmless.
--
-- NOT VALID is deliberate: it enforces the rule on every INSERT and UPDATE from
-- now on WITHOUT scanning existing rows. That matters because the already-
-- published bad post is still in the table — adding a validating constraint
-- would fail outright. Clean up first (step 1), then optionally validate
-- (step 4).
-- ---------------------------------------------------------------------------


-- 1. FIRST: find rows already affected, so you can fix or delete them.
--    Run this on its own and review the results before adding the constraints.
SELECT
  id,
  slug,
  status,
  read_time,
  char_length(raw_markdown) AS raw_chars,
  published_at
FROM public.posts
WHERE raw_markdown IS NOT NULL
  AND (
       raw_markdown LIKE '%"bodyMarkdown"%'
    OR raw_markdown LIKE '%"metaDescription"%'
    OR raw_markdown LIKE '%```json%'
    OR raw_markdown ~* '\m(wait|actually|perfect)\s*[,.]?\s*let me\M'
    OR raw_markdown ~* '\mlet me (recount|refine|verify|double-check)\M'
    OR raw_markdown LIKE '%✓%'
    OR char_length(raw_markdown) > 12000
  )
ORDER BY published_at DESC NULLS LAST;


-- 2. Reject bodies containing the model's own scaffolding.
--    Each pattern is unambiguous: none can occur in a legitimate article written
--    under the writer prompt's rules (which already forbid code fences, emoji
--    and raw tags).
ALTER TABLE public.posts
  ADD CONSTRAINT posts_raw_markdown_uncontaminated
  CHECK (
    raw_markdown IS NULL OR (
          raw_markdown NOT LIKE '%"bodyMarkdown"%'
      AND raw_markdown NOT LIKE '%"metaDescription"%'
      AND raw_markdown NOT LIKE '%```json%'
      AND raw_markdown !~* '\m(wait|actually|perfect)\s*[,.]?\s*let me\M'
      AND raw_markdown !~* '\mlet me (recount|refine|verify|double-check)\M'
      AND raw_markdown NOT LIKE '%✓%'
      AND raw_markdown NOT LIKE '%<cite%'
    )
  ) NOT VALID;


-- 3. Reject bodies far outside the 500-800 word target.
--    ~12,000 characters is roughly 1,850 words — comfortably above any
--    legitimate post, and below the ~15,000 characters the leaked three-draft
--    body occupied. The lower bound catches the silently-empty-post failure.
ALTER TABLE public.posts
  ADD CONSTRAINT posts_raw_markdown_length_sane
  CHECK (
    raw_markdown IS NULL
    OR char_length(raw_markdown) BETWEEN 500 AND 12000
  ) NOT VALID;


-- 4. OPTIONAL, and only after step 1 returns no rows: promote the constraints to
--    fully validated so the guarantee covers historical rows too.
-- ALTER TABLE public.posts VALIDATE CONSTRAINT posts_raw_markdown_uncontaminated;
-- ALTER TABLE public.posts VALIDATE CONSTRAINT posts_raw_markdown_length_sane;


-- ROLLBACK, if either constraint ever blocks something it shouldn't:
-- ALTER TABLE public.posts DROP CONSTRAINT posts_raw_markdown_uncontaminated;
-- ALTER TABLE public.posts DROP CONSTRAINT posts_raw_markdown_length_sane;
