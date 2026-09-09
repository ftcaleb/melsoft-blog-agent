// One-time (manual) script to register the Melsoft blog-agent slash commands
// with Discord. Run it whenever the command definitions below change — nothing
// registers automatically on deploy:
//
//   node scripts/registerDiscordCommands.js                  # global scope
//   node scripts/registerDiscordCommands.js --guild <id>     # one server, instant
//   node scripts/registerDiscordCommands.js --guild <id> --clear-global
//
// This is NOT part of the server's request path — it never runs on boot. It
// performs a full command-list overwrite (PUT) authenticated with the bot token.
//
// SCOPE MATTERS FOR SPEED. Global registrations can take up to ~1 hour to
// appear in Discord clients (and clients cache the list hard). Guild-scoped
// registrations apply immediately. The bot only operates in one server, so
// guild scope is the practical choice; set DISCORD_GUILD_ID (or pass --guild)
// to use it. Keeping BOTH a global and a guild set makes every command show
// up twice once global propagation catches up — --clear-global wipes the
// global set for exactly that reason. It deliberately refuses to run without
// a guild id, since that would leave the bot with no commands at all.
//
// Required env vars (already set locally and in Vercel):
//   DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN
// Optional: DISCORD_GUILD_ID (the Melsoft server id) for instant, server-scoped
// registration.
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

// Optional on every command; omitting it defaults to Academy (see
// src/profiles.js getProfile()), so every existing invocation habit keeps
// working unchanged. Choice VALUES are the profile keys used throughout the
// codebase (PROFILES.academy / PROFILES.digital) — not just display labels.
const LINE_OPTION = {
  type: STRING_OPTION,
  name: 'line',
  description: 'Which content line — defaults to Academy if omitted.',
  required: false,
  choices: [
    { name: 'Academy', value: 'academy' },
    { name: 'Digital', value: 'digital' },
  ],
};

const commands = [
  {
    name: 'topics',
    description: 'Show the current trending blog topics (from the research cache).',
    options: [LINE_OPTION],
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
      LINE_OPTION,
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
      LINE_OPTION,
    ],
  },
  // One-word shortcuts per content line: post a fresh pick-a-topic message
  // (numbered list + Generate buttons, same as the scheduled cron) on demand.
  {
    name: 'academy',
    description: 'Pick a Melsoft Academy topic to draft — posts the current list with Generate buttons.',
  },
  {
    name: 'digital',
    description: 'Pick a Melsoft Digital topic to draft — posts the current list with Generate buttons.',
  },
];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const GUILD_ID = process.env.DISCORD_GUILD_ID || argValue('--guild');
const CLEAR_GLOBAL = process.argv.includes('--clear-global');

const API = 'https://discord.com/api/v10';
const headers = { 'Content-Type': 'application/json', Authorization: `Bot ${BOT_TOKEN}` };

// Full overwrite of one command set. Exits on failure so a half-applied state
// is never reported as success; Discord returns the stored list on success.
async function overwrite(url, body, label) {
  const resp = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`${label} failed: HTTP ${resp.status}`);
    console.error(text);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

async function main() {
  if (CLEAR_GLOBAL && !GUILD_ID) {
    console.error('--clear-global requires a guild id (DISCORD_GUILD_ID or --guild <id>) — otherwise the bot would be left with no commands at all.');
    process.exit(1);
  }

  const scope = GUILD_ID ? `guild ${GUILD_ID}` : 'global';
  const url = GUILD_ID
    ? `${API}/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
    : `${API}/applications/${APPLICATION_ID}/commands`;

  const registered = await overwrite(url, commands, `Command registration (${scope})`);
  console.log(`Registered ${registered.length} ${scope} command(s):`);
  registered.forEach((c) => console.log(`  /${c.name}`));

  if (CLEAR_GLOBAL) {
    await overwrite(`${API}/applications/${APPLICATION_ID}/commands`, [], 'Clearing global commands');
    console.log('Cleared the global command set — the guild-scoped set is now the only one.');
  }

  console.log(
    GUILD_ID
      ? 'Guild-scoped commands apply immediately (a Discord restart / Ctrl+R may still be needed to refresh the picker).'
      : 'Global commands can take up to ~1 hour to appear in Discord.'
  );
}

main().catch((err) => {
  console.error('Unexpected error registering commands:', err.message);
  process.exit(1);
});
