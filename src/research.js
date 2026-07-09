// Deliverable 1: research agent
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to resolve paths from project root
const getProjectPath = (relPath) => path.resolve(__dirname, '..', relPath);

/**
 * Calculates the Levenshtein distance between two strings.
 */
function levenshteinDistance(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,       // deletion
        matrix[i][j - 1] + 1,       // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[len1][len2];
}

/**
 * Checks if two titles are close or fuzzy matches.
 */
function isFuzzyMatch(title1, title2) {
  if (!title1 || !title2) return false;
  
  const t1 = title1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t2 = title2.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Direct substring check
  if (t1.includes(t2) || t2.includes(t1)) {
    return true;
  }
  
  // Levenshtein similarity check
  const maxLen = Math.max(t1.length, t2.length);
  if (maxLen === 0) return true;
  const dist = levenshteinDistance(t1, t2);
  const similarity = 1 - dist / maxLen;
  return similarity > 0.85; // 85% similarity threshold
}

/**
 * Produces a list of candidate blog topics for Melsoft Academy.
 * Combines recent web-searched trends in South Africa with evergreen topics.
 * Dedupes against data/post_log.json.
 * 
 * @returns {Promise<Array>} List of candidate topic objects
 */
export async function generateCandidates() {
  const evergreenPath = getProjectPath('data/evergreen_topics.json');
  const postLogPath = getProjectPath('data/post_log.json');

  // 1. Read evergreen topics
  let evergreenCandidates = [];
  try {
    const evergreenRaw = await fs.readFile(evergreenPath, 'utf8');
    const evergreenTopics = JSON.parse(evergreenRaw);
    evergreenCandidates = evergreenTopics.map(topic => ({
      title: topic.title,
      pitch: topic.pitch,
      pillar: topic.pillar,
      type: 'evergreen',
      sourceNotes: 'evergreen bank'
    }));
  } catch (error) {
    console.warn('Warning: Could not read evergreen_topics.json. Defaulting to empty.', error.message);
  }

  // 2. Read post log for deduping
  let pastPosts = [];
  try {
    const postLogRaw = await fs.readFile(postLogPath, 'utf8');
    pastPosts = JSON.parse(postLogRaw);
  } catch (error) {
    console.warn('Warning: Could not read post_log.json. Defaulting to empty list.', error.message);
  }

  // 3. Fetch recent trending candidates from Anthropic with web_search
  let recentCandidates = [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('Warning: ANTHROPIC_API_KEY is not defined in process.env. Skipping recent candidates generation.');
  } else {
    try {
      const anthropic = new Anthropic({ apiKey });
      
      const promptText = `
        You are a research agent for Melsoft Academy, a South African training provider.
        
        Using the web_search tool, find what's trending in South Africa in the last ~2 weeks across these topics ONLY:
        - AI, cybersecurity, data science (tech pillar)
        - learnerships, B-BBEE, SETA landscape, employment equity targets, QCTO qualifications, youth upskilling (skills pillar)
        
        Based on your findings, formulate a list of trending candidate blog post topics for Melsoft Academy.
        
        CRITICAL REQUIREMENTS:
        1. Every candidate must have BOTH a South African angle and an educational "what it means / what to do" angle (practical value/insights for learners, companies, or the local community), not just reporting "what happened".
        2. Return ONLY a valid JSON array of candidate objects.
        3. Do NOT include markdown code fences (like \`\`\`json), preamble, explanations, or postscript.
        4. The array must contain objects matching this exact shape:
        {
          "title": "string",
          "pitch": "string (one-line description of the angle)",
          "pillar": "tech" or "skills",
          "type": "recent",
          "sourceNotes": "string (details of the source or URL found)"
        }
      `;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          { role: 'user', content: promptText }
        ]
      });

      let responseText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();
      
      // Defensively strip code fences if present
      if (responseText.startsWith('```')) {
        responseText = responseText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      }

      recentCandidates = JSON.parse(responseText);
      if (!Array.isArray(recentCandidates)) {
        recentCandidates = [];
      }
    } catch (error) {
      console.error('Error fetching recent candidates from Anthropic:', error);
    }
  }

  // 4. Combine recent and evergreen candidates
  const allCandidates = [...recentCandidates, ...evergreenCandidates];

  // 5. Deduplicate against past posts
  const filteredCandidates = allCandidates.filter(candidate => {
    const isDuplicate = pastPosts.some(pastPost => isFuzzyMatch(candidate.title, pastPost.title));
    return !isDuplicate;
  });

  return filteredCandidates;
}

// standalone run block
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('--- STANDALONE TESTING: src/research.js ---');
  console.log('Generating candidates...');
  
  generateCandidates()
    .then(candidates => {
      console.log(`\nSuccessfully generated ${candidates.length} candidates:\n`);
      console.log(JSON.stringify(candidates, null, 2));
    })
    .catch(err => {
      console.error('Failed standalone run:', err);
    });
}
