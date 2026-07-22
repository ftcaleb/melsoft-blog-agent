// ---------------------------------------------------------------------------
// Maintenance migration: backfill the `cluster` tag on existing posts so
// per-cluster performance (Deliverable 6/7) can be read across historical
// content, not just posts generated after cluster tagging shipped.
//
// It classifies each post from its title/pillar/source_topic via the SAME
// classifyCluster() the writer uses, so backfilled tags match new ones.
//
// Usage:
//   node scripts/migrateClusters.js            # DRY RUN — preview proposed tags (works even before the column exists)
//   node scripts/migrateClusters.js --apply    # write cluster values to Supabase (requires the `cluster` column)
//
// One-time schema step (run in the Supabase SQL editor before --apply):
//   alter table posts add column if not exists cluster text;
//
// Safe to re-run. Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env.
// ---------------------------------------------------------------------------
import { supabase } from '../src/supabaseClient.js';
import { classifyCluster } from '../src/keywords.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  // Select only always-present columns so the DRY RUN works before the `cluster`
  // column is added. On --apply we still only need the id to update.
  const { data, error } = await supabase
    .from('posts')
    .select('id, title, pillar, source_topic, status')
    .order('created_at', { ascending: false });

  if (error) { console.error('Query failed:', error.message); process.exit(1); }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — classifying ${data.length} posts.\n`);

  const counts = {};
  let applied = 0, unclassified = 0, failed = 0;

  for (const p of data) {
    const cluster = classifyCluster({ title: p.title, pillar: p.pillar, sourceTopic: p.source_topic });
    counts[cluster || '(none)'] = (counts[cluster || '(none)'] || 0) + 1;
    if (!cluster) unclassified++;

    console.log(`  [${(p.pillar || '?').padEnd(6)}] ${String(cluster || '(unclassified)').padEnd(20)} ${p.title.slice(0, 60)}`);

    if (APPLY && cluster) {
      const { error: updErr } = await supabase.from('posts').update({ cluster }).eq('id', p.id);
      if (updErr) { failed++; console.log(`         ✗ ${updErr.message}`); }
      else applied++;
    }
  }

  console.log('\n' + '—'.repeat(50));
  console.log('Distribution: ' + Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(', '));
  if (APPLY) console.log(`Applied ${applied}, unclassified (left null) ${unclassified}, failed ${failed}`);
  else console.log(`${data.length - unclassified} would be tagged, ${unclassified} unclassified (would stay null).\nRe-run with --apply after adding the column to write these.`);
}

main().catch((err) => { console.error('Unexpected error:', err.message); process.exit(1); });
