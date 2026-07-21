// ---------------------------------------------------------------------------
// Maintenance migration: normalize existing posts' FAQ sections so the Melsoft
// website renders them as the collapsible accordion (consistent with newer
// posts). It rewrites each post's stored `body` blocks in place using
// normalizeFaqBlocks() — an h3/"FAQ" heading + "Q:"/"A:" paragraphs become an
// h2 "Frequently Asked Questions" + h3 (question) + p (answer) structure.
//
// It only touches the FAQ block range; all other blocks are left byte-for-byte
// as they are (no regeneration from markdown, so manual edits are preserved).
// Posts whose FAQ is already correct are skipped (the normalizer is idempotent).
//
// Usage:
//   node scripts/migrateFaqBlocks.js                   # DRY RUN — report only, writes nothing
//   node scripts/migrateFaqBlocks.js --apply           # write ALL normalized bodies back to Supabase
//   node scripts/migrateFaqBlocks.js --slug=<slug>     # dry-run a single post (canary)
//   node scripts/migrateFaqBlocks.js --slug=<slug> --apply   # apply just that one post
//
// Safe to re-run. Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env.
// ---------------------------------------------------------------------------
import { supabase } from '../src/supabaseClient.js';
import { normalizeFaqBlocks } from '../src/markdownToBlocks.js';

const APPLY = process.argv.includes('--apply');
const slugArg = process.argv.find((a) => a.startsWith('--slug='));
const ONLY_SLUG = slugArg ? slugArg.slice('--slug='.length) : null;

function faqSummary(blocks) {
  const i = blocks.findIndex(
    (b) => (b.type === 'h2' || b.type === 'h3') && /faqs?\b|frequently asked/i.test(b.text || '')
  );
  if (i === -1) return '(no FAQ section)';
  const counts = {};
  let end = blocks.length;
  for (let j = i + 1; j < blocks.length; j++) if (blocks[j].type === 'h2') { end = j; break; }
  blocks.slice(i, end).forEach((b) => { counts[b.type] = (counts[b.type] || 0) + 1; });
  const head = blocks[i];
  return `${head.type}:"${(head.text || '').slice(0, 40)}" | ${Object.entries(counts).map(([t, n]) => `${n}×${t}`).join(', ')}`;
}

async function main() {
  let query = supabase
    .from('posts')
    .select('id, title, slug, status, body')
    .order('created_at', { ascending: false });
  if (ONLY_SLUG) query = query.eq('slug', ONLY_SLUG);

  const { data, error } = await query;

  if (error) { console.error('Query failed:', error.message); process.exit(1); }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}${ONLY_SLUG ? ` — single post: ${ONLY_SLUG}` : ''} — scanning ${data.length} post(s).\n`);

  let changed = 0, skipped = 0, failed = 0;

  for (const p of data) {
    const body = Array.isArray(p.body) ? p.body : [];
    const normalized = normalizeFaqBlocks(body);

    if (JSON.stringify(normalized) === JSON.stringify(body)) { skipped++; continue; }

    changed++;
    console.log('• ' + p.title);
    console.log(`    [${p.status}] ${p.slug}`);
    console.log(`    before: ${faqSummary(body)}`);
    console.log(`    after : ${faqSummary(normalized)}`);

    if (APPLY) {
      const { error: updErr } = await supabase.from('posts').update({ body: normalized }).eq('id', p.id);
      if (updErr) { failed++; console.log(`    ✗ update failed: ${updErr.message}`); }
      else console.log('    ✓ updated');
    }
    console.log('');
  }

  console.log('—'.repeat(50));
  console.log(`${changed} would change, ${skipped} already correct / no FAQ` + (APPLY ? `, ${failed} failed` : ''));
  if (!APPLY && changed) console.log('\nRe-run with --apply to write these changes to Supabase.');
}

main().catch((err) => { console.error('Unexpected error:', err.message); process.exit(1); });
