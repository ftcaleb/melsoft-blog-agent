// One-time (manual) script to register the Melsoft blog-agent slash commands
// with Discord. Run it whenever the command definitions below change:
//
//   node scripts/registerDiscordCommands.js
//
// This is NOT part of the server's request path — it never runs on boot. It
// performs a global command overwrite via
//   PUT /applications/{DISCORD_APPLICATION_ID}/commands
// authenticated with the bot token ("Authorization: Bot <token>"). Global
// command propagation can take up to ~1 hour on Discord's side.
//
// Required env vars (already set locally and in Vercel):
//   DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN
import dotenv from 'dotenv';

dotenv.config();

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
  // Never print the values themselves — only which one is missing.
  console.error(
    'Missing required env var(s):' +
      (APPLICATION_ID ? '' : ' DISCORD_APPLICATION_ID') +
      (BOT_TOKEN ? '' : ' DISCORD_BOT_TOKEN')
  );
  process.exit(1);
}

// STRING option type = 3 in the Discord API.
const STRING_OPTION = 3;

const commands = [
  {
    name: 'topics',
    description: 'Show the current trending blog topics (from the research cache).',
  },
  {
    name: 'generate',
    description: 'Draft a blog post for a topic (saves a draft — does not publish).',
    options: [
      {
        type: STRING_OPTION,
        name: 'topic',
        description: 'The topic title to write a draft about.',
        required: true,
      },
    ],
  },
  {
    name: 'publish',
    description: 'Publish an existing draft live by its slug.',
    options: [
      {
        type: STRING_OPTION,
        name: 'slug',
        description: 'The slug of the draft to publish.',
        required: true,
      },
    ],
  },
];

async function main() {
  const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${BOT_TOKEN}`,
    },
    body: JSON.stringify(commands),
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error(`Command registration failed: HTTP ${resp.status}`);
    console.error(text);
    process.exit(1);
  }

  let registered;
  try {
    registered = JSON.parse(text);
  } catch {
    registered = [];
  }
  console.log(`Registered ${Array.isArray(registered) ? registered.length : 0} command(s):`);
  (Array.isArray(registered) ? registered : []).forEach((c) => console.log(`  /${c.name}`));
  console.log('Global commands can take up to ~1 hour to appear in Discord.');
}

main().catch((err) => {
  console.error('Unexpected error registering commands:', err.message);
  process.exit(1);
});
