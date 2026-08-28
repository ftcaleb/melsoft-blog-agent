// Renders the Step 4 draft-preview message into the Discord channel, using an
// EXISTING draft so nothing is generated and nothing is billed.
//
//   node scripts/previewDiscordDraftMessage.js <slug>
//
// Why this exists: Discord cannot reach a local server, so the interaction path
// can only be exercised once deployed. This posts the byte-identical payload
// that handleGenerateDeferred() builds — same embed builder, same button — so
// the rendering and the Publish button can be verified before deploying.
//
// The Publish button routes to the DEPLOYED interactions endpoint, where
// `publish:<slug>` is long-standing unchanged behaviour. Clicking it WILL
// publish the post to the live website.
import dotenv from 'dotenv';
import { supabase } from '../src/supabaseClient.js';
import { buildDraftEmbeds, buildDraftComponents } from '../src/discordInteractions.js';

dotenv.config();

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: node scripts/previewDiscordDraftMessage.js <slug>');
  process.exit(1);
}

const botToken = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
if (!botToken || !channelId) {
  console.error(
    'Missing env var(s):' +
      (botToken ? '' : ' DISCORD_BOT_TOKEN') +
      (channelId ? '' : ' DISCORD_CHANNEL_ID')
  );
  process.exit(1);
}

const { data: post, error } = await supabase
  .from('posts')
  .select('id, slug, title, excerpt, image, status')
  .eq('slug', slug)
  .maybeSingle();

if (error) {
  console.error('Lookup failed:', error.message);
  process.exit(1);
}
if (!post) {
  console.error(`No post found with slug "${slug}"`);
  process.exit(1);
}

console.log(`Post   : ${post.title}`);
console.log(`Status : ${post.status}`);
console.log(`Image  : ${post.image || '(none)'}`);

// Identical construction to handleGenerateDeferred().
const appUrl = process.env.APP_URL || 'https://melsoft-blog.vercel.app';
const content = post.image
  ? `Draft ready — review the image below.\nSlug: \`${post.slug}\`\n${appUrl}/dashboard.html`
  : `Draft ready: **${post.title}**\nSlug: \`${post.slug}\`\n⚠️ No featured image was generated.`;

const embeds = buildDraftEmbeds(post.title, post.excerpt, post.image);
const components = buildDraftComponents(post.id, post.image);

const payload = { content, components };
if (embeds) payload.embeds = embeds;

const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
  body: JSON.stringify(payload),
});

if (!resp.ok) {
  // Status only — never the token.
  console.error(`Discord responded ${resp.status}`);
  console.error((await resp.text()).slice(0, 800));
  process.exit(1);
}

const sent = await resp.json();
console.log(`\nPosted to Discord. Message id: ${sent.id}`);
console.log(`Embeds attached: ${(sent.embeds || []).length}`);
console.log(`Image rendered by Discord: ${sent.embeds && sent.embeds[0] && sent.embeds[0].image ? 'yes' : 'no'}`);
