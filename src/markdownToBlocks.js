import { marked } from 'marked';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

/**
 * Resolves encoding issues (Mojibake) in a text string.
 *
 * @param {string} str - The text to clean
 * @returns {string} The cleaned UTF-8 text
 */
function cleanMojibake(str) {
  if (typeof str !== 'string') return str;
  let s = str;
  
  // Specific multi-char sequences
  s = s.replace(/â€™/g, "'");
  s = s.replace(/â€œ/g, '"');
  s = s.replace(/â€¦/g, '…');
  
  // UTF-8 code sequences decoded incorrectly in Windows-1252:
  // em dash: â€” (code 226, 8364, 8212 or 8221 depending on CP1252 conversion)
  s = s.replace(/\u00e2\u20ac\u201d/g, '—'); // â€” using 8221 (”)
  s = s.replace(/\u00e2\u20ac\u201c/g, '–'); // â€“ using 8220 (“)
  s = s.replace(/â€”/g, '—');
  s = s.replace(/â€“/g, '–');
  
  // What about â€" with literal double quote (code 34)?
  // We can convert it to en dash if between digits, or em dash otherwise.
  s = s.replace(/([0-9]+)\s*â€"\s*([0-9]+)/g, '$1–$2');
  s = s.replace(/â€"/g, '—');
  
  // Finally: â€ followed by nothing meaningful -> "
  // Also ensures no "â€" sequences remain.
  s = s.replace(/â€/g, '"');
  
  return s;
}

/**
 * Recursively converts inline tokens to a plain text string.
 *
 * @param {object[]} tokens - Marked inline tokens
 * @returns {string} Plain text string
 */
function inlineToText(tokens) {
  if (!tokens) return '';
  return tokens.map(token => {
    switch (token.type) {
      case 'br':
        return '\n';
      case 'codespan':
        return token.text;
      case 'text':
      case 'escape':
      case 'html':
        if (token.tokens) {
          return inlineToText(token.tokens);
        }
        return token.text;
      default:
        if (token.tokens) {
          return inlineToText(token.tokens);
        }
        return token.text || '';
    }
  }).join('');
}

/**
 * Extracts plain text from a block or inline token.
 *
 * @param {object} token - Marked token
 * @returns {string} Plain text
 */
function extractText(token) {
  if (!token) return '';
  if (token.tokens) {
    return inlineToText(token.tokens);
  }
  return token.text || '';
}

/**
 * Converts a markdown string into a structured block array.
 *
 * @param {string} markdown - The markdown content to convert
 * @param {string} [title] - The post title; if the body opens with a heading
 *   that duplicates it, that leading heading is stripped so the page doesn't
 *   render the title twice.
 * @returns {object[]} Array of blocks
 */
export function markdownToBlocks(markdown, title = '') {
  if (!markdown) return [];
  
  const cleanedMarkdown = cleanMojibake(markdown);
  const tokens = marked.lexer(cleanedMarkdown);
  const blocks = [];
  
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const depth = token.depth;
        // Markdown ## → h2, ### → h3. (There is no h1 in the body; if an h1 appears, treat it as h2.)
        const type = depth <= 2 ? 'h2' : 'h3';
        const text = cleanMojibake(extractText(token).trim());
        blocks.push({ type, text });
        break;
      }
      case 'paragraph': {
        const text = cleanMojibake(extractText(token).trim());
        if (text) {
          blocks.push({ type: 'p', text });
        }
        break;
      }
      case 'blockquote': {
        const rawQuoteText = token.tokens
          ? token.tokens.map(t => extractText(t)).filter(Boolean).join('\n\n').trim()
          : (token.text || '').trim();

        // Clean the whole quote text FIRST, then split off the attribution.
        // A mojibake-corrupted dash (e.g. "â€”") would otherwise defeat the
        // attribution regex if the split ran on the raw text.
        const quoteText = cleanMojibake(rawQuoteText);
        let text = quoteText;
        let who = '';

        // If the quote text contains a trailing attribution line starting with —, --, or -, split it
        const lines = quoteText.split('\n');
        if (lines.length > 1) {
          const lastLine = lines[lines.length - 1].trim();
          const match = lastLine.match(/^(?:—|--|-)\s*(.+)$/);
          if (match) {
            who = match[1].trim();
            text = lines.slice(0, -1).join('\n').trim();
          }
        }

        blocks.push({ type: 'quote', text, who });
        break;
      }
      case 'list': {
        const type = token.ordered ? 'ol' : 'ul';
        const items = token.items
          .map(item => cleanMojibake(extractText(item).trim()))
          .filter(Boolean);
        blocks.push({ type, items });
        break;
      }
      case 'table': {
        // The React renderer has no table block, so degrade to a bulleted list.
        // Drop the header row; each body row becomes one item shaped as
        // "<first cell>: <remaining cells joined with ' — '>". Inline bold/links
        // flatten to plain text via the existing extract helpers.
        const items = [];
        for (const row of (token.rows || [])) {
          const cells = row.map(cell => cleanMojibake(extractText(cell).trim()));
          if (cells.every(cell => !cell)) continue; // skip empty rows
          const [first, ...rest] = cells;
          const tail = rest.filter(Boolean).join(' — ');
          const item = tail ? `${first}: ${tail}` : first;
          if (item) items.push(item);
        }
        if (items.length) {
          blocks.push({ type: 'ul', items });
        }
        break;
      }
      case 'code': {
        // Fenced code blocks have no dedicated block type; emit as a paragraph
        // so the content is never silently lost.
        blocks.push({ type: 'p', text: token.text });
        break;
      }
      // Horizontal rules (---) → dropped entirely (no block)
      case 'hr':
      default:
        break;
    }
  }

  // A3: strip a leading heading that merely repeats the post title, so the
  // rendered page doesn't show the title twice. Only ever the first block.
  if (title && blocks.length > 0) {
    const first = blocks[0];
    if (first.type === 'h2' || first.type === 'h3') {
      const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalize(first.text) === normalize(title)) {
        blocks.shift();
      }
    }
  }

  return blocks;
}

/**
 * Computes estimated reading time for a markdown string.
 *
 * @param {string} markdown - The markdown content
 * @returns {string} e.g. "6 min read"
 */
export function computeReadTime(markdown) {
  if (!markdown) return '1 min read';
  
  const blocks = markdownToBlocks(markdown);
  let textForWordCount = '';
  
  for (const block of blocks) {
    if (block.type === 'h2' || block.type === 'h3' || block.type === 'p') {
      textForWordCount += (block.text || '') + ' ';
    } else if (block.type === 'quote') {
      textForWordCount += (block.text || '') + ' ' + (block.who || '') + ' ';
    } else if (block.type === 'ul' || block.type === 'ol') {
      textForWordCount += (block.items || []).join(' ') + ' ';
    }
  }
  
  const words = textForWordCount.trim().split(/\s+/).filter(Boolean).length;
  const mins = Math.max(1, Math.ceil(words / 200));
  return `${mins} min read`;
}

// Standalone testing block
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('--- STANDALONE TESTING: src/markdownToBlocks.js ---');
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const outputMdPath = path.join(projectRoot, 'output.md');
    
    console.log(`Reading from: ${outputMdPath}`);
    const markdown = await fs.readFile(outputMdPath, 'utf8');
    
    const blocks = markdownToBlocks(markdown);
    const readTime = computeReadTime(markdown);
    
    console.log('\n--- Computed Read Time ---');
    console.log(readTime);
    
    console.log('\n--- Parsed Blocks (JSON) ---');
    console.log(JSON.stringify(blocks, null, 2));
  } catch (err) {
    console.error('Error during standalone test run:', err);
  }
}
