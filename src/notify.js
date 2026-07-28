// Shared Discord notification sender.
//
// Extracted from server.js so modules that server.js itself imports (research,
// writer call sites) can raise alerts without a circular import. server.js
// re-exports notifyDiscord, so existing importers are unaffected.

/**
 * Sends a Discord notification. Awaited (so it finishes before a serverless
 * function returns) but non-fatal: everything is logged, never thrown.
 *
 * Two delivery paths, chosen automatically:
 *   1. BOT-TOKEN channel message — used when interactive `components` (buttons)
 *      are present AND both DISCORD_CHANNEL_ID and DISCORD_BOT_TOKEN are set.
 *      Components render natively on bot-sent messages (no ?with_components=true
 *      and no special flag). A plain channel webhook is NOT application-owned
 *      and cannot render interactive buttons, so this is the only path that can.
 *   2. WEBHOOK (DISCORD_WEBHOOK_URL) — the original behaviour, used when there
 *      are no components, or when the bot path is unconfigured or fails. When
 *      components are absent this is byte-for-byte the original plain-text post.
 *
 * The bot token is used only as an Authorization header — never logged, printed,
 * or included in any error message.
 *
 * @param {string} content Message text (truncated to Discord's 2000-char cap)
 * @param {object[]} [components] Optional action rows
 */
export async function notifyDiscord(content, components) {
  // Discord caps message content at 2000 chars.
  const contentStr = String(content).slice(0, 1990);
  const hasComponents = Array.isArray(components) && components.length > 0;

  const botToken = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  // Path 1: bot-token channel message (only when we have buttons to render and
  // the bot is configured). On success we're done; on failure we fall through
  // to the webhook path so a notification is never lost.
  if (hasComponents && botToken && channelId) {
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${botToken}`,
        },
        body: JSON.stringify({ content: contentStr, components }),
      });
      if (resp.ok) return;
      // Log status only — never the token or headers.
      console.warn(`[discord] Bot channel message responded ${resp.status}; falling back to webhook.`);
    } catch (err) {
      console.warn('[discord] Bot channel message failed:', err.message);
    }
  }

  // Path 2: webhook fallback (original behaviour). Skipped silently if no URL.
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const base = { content: contentStr };

  const send = (payload, withComponents) => {
    const endpoint = withComponents
      ? url + (url.includes('?') ? '&' : '?') + 'with_components=true'
      : url;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  try {
    let resp;
    if (hasComponents) {
      resp = await send({ ...base, components }, true);
      if (!resp.ok) {
        console.warn(`[discord] Webhook with components responded ${resp.status}; retrying as plain text.`);
        resp = await send(base, false);
      }
    } else {
      resp = await send(base, false);
    }
    if (!resp.ok) console.warn(`[discord] Webhook responded ${resp.status}`);
  } catch (err) {
    console.warn('[discord] Notification failed:', err.message);
  }
}

/**
 * Raises a visible alert when the pipeline rejects its own output.
 *
 * Without this, a rejected draft or a poisoned research batch only reached
 * console.error — invisible on Vercel/Render. The published-commentary incident
 * was discovered by a human reading the live site; this is what makes the
 * pipeline report its own failures instead.
 *
 * Never throws: an alerting failure must not mask the failure being alerted on.
 *
 * @param {string} context Short label, e.g. 'Draft generation'
 * @param {string} summary One-line description of what went wrong
 * @param {string[]} [reasons] Specific reasons, rendered as a bullet list
 */
export async function notifyFailure(context, summary, reasons = []) {
  try {
    const lines = [`🚨 **${context} rejected — nothing was saved**`, summary];
    if (reasons.length) {
      lines.push('', ...reasons.slice(0, 8).map((r) => `• ${r}`));
    }
    await notifyDiscord(lines.join('\n'));
  } catch (err) {
    console.warn('[notify] Could not send failure alert:', err.message);
  }
}
