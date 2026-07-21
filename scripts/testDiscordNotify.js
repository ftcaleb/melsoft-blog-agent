// ---------------------------------------------------------------------------
// TEMPORARY / TEST-ONLY — not wired into any production route.
//
// A standalone, one-off manual check for the Discord cron-notification buttons.
// It calls buildTopicButtons() + notifyDiscord() (exported from server.js)
// DIRECTLY with fake in-memory topics. It does NOT touch Supabase, does NOT
// call Claude, and does NOT go through the cron route or CRON_SECRET.
//
// Usage:
//   node scripts/testDiscordNotify.js --dry-run   # log the payload only, send nothing
//   node scripts/testDiscordNotify.js             # log the payload, THEN post to DISCORD_WEBHOOK_URL
//
// What it proves:
//   - buildTopicButtons() skips a topic whose custom_id would exceed Discord's
//     100-char limit (one fake topic below has a >100-char title on purpose).
//   - Whether the real webhook renders the buttons, or notifyDiscord() falls
//     back to plain text (which would tell you the webhook is not
//     application-owned).
//
// Kept as a manual debug utility — safe to re-run any time to re-check button
// rendering vs. plain-text fallback. Not imported by any production route.
// ---------------------------------------------------------------------------
import { notifyDiscord, buildTopicButtons } from '../server.js';

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

// Fake, in-memory sample topics. No DB, no API. The THIRD title is deliberately
// long enough that `generate:<title>` exceeds 100 chars, so its button is
// skipped by buildTopicButtons() while it stays in the text list.
const fakeTopics = [
  { title: 'AI Chatbots for South African Small Businesses' },
  { title: 'Cybersecurity Basics Every Remote Worker Should Know in 2026' },
  {
    title:
      'A Very Long Deliberately Overlong Blog Topic Title About Cloud Migration Strategies That Definitely Exceeds The One Hundred Character Custom Id Limit',
  },
];

// Mirror the exact message/text the cron builds so the review is representative.
const appUrl = process.env.APP_URL || 'https://melsoft-blog.vercel.app';
const list = fakeTopics.map((c, i) => `${i + 1}. ${c.title}`).join('\n');
const message =
  `🔔 **[TEST] Fresh blog topics generated** — ${fakeTopics.length} new candidates\n\n` +
  `👉 **Open the blog agent:** ${appUrl}\n\n${list}\n\n` +
  `🖱️ Tap **Generate #N** below to draft that topic here in Discord.`;

const components = buildTopicButtons(fakeTopics);

// Reconstruct the exact JSON body notifyDiscord() will POST, so it can be
// reviewed BEFORE anything is sent.
const payload = { content: message.slice(0, 1990), components };

console.log('=== Discord webhook payload (review before sending) ===');
console.log(JSON.stringify(payload, null, 2));
console.log('=======================================================');
console.log(
  `Built ${components.length} action row(s); ` +
    `${components.reduce((n, r) => n + r.components.length, 0)} button(s) ` +
    `(the >100-char-custom_id topic is intentionally skipped).`
);

if (DRY_RUN) {
  console.log('\n[dry-run] Nothing sent. Re-run without --dry-run to POST to DISCORD_WEBHOOK_URL.');
} else {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.log('\nDISCORD_WEBHOOK_URL is not set — notifyDiscord() will no-op. Nothing sent.');
  } else {
    console.log('\nSending to the real DISCORD_WEBHOOK_URL...');
  }
  await notifyDiscord(message, components);
  console.log('Done. Check the Discord channel: buttons = webhook is application-owned; plain text = fallback.');
}
