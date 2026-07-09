// Deliverable 2: topic selection (2 tech + 1 skills)
import { generateCandidates } from './research.js';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Loosely parses year and month from source notes to estimate date.
 * Returns a numerical score representation of the date (higher is more recent).
 * 
 * @param {string} notes Source notes to parse
 * @returns {number} Numeric date score (year * 12 + monthIndex)
 */
function parseDateFromNotes(notes) {
  if (!notes) return 0;
  
  // Regex to extract 4-digit years (e.g. 2024, 2025, 2026)
  const yearMatch = notes.match(/\b(202[4-6])\b/);
  if (!yearMatch) return 0;
  const year = parseInt(yearMatch[1], 10);

  // Month keywords mapping to index
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let monthIndex = 0; // Default to beginning of the year if not specified
  
  const lowerNotes = notes.toLowerCase();
  for (let i = 0; i < months.length; i++) {
    if (lowerNotes.includes(months[i])) {
      monthIndex = i;
      break;
    }
  }

  return year * 12 + monthIndex;
}

/**
 * Scores a candidate based on type and date recency in source notes.
 * 
 * @param {object} candidate The candidate topic object
 * @returns {number} Calculated score
 */
function scoreCandidate(candidate) {
  if (candidate.type === 'evergreen') {
    return 50; // Flat baseline score for evergreen candidates
  }
  
  // Recent candidates start with a base score and get a recency bonus
  const baseScore = 100;
  const dateScore = parseDateFromNotes(candidate.sourceNotes);
  return baseScore + dateScore;
}

/**
 * Selects exactly 3 topics from candidates:
 * - Exactly 2 from "tech" pillar
 * - Exactly 1 from "skills" pillar
 * - Incorporates variety within the "tech" picks (prefers 1 recent + 1 evergreen)
 * 
 * @param {Array} candidates Array of candidate topic objects
 * @returns {Array} Selected 3 topic objects
 */
export function selectTopics(candidates) {
  if (!Array.isArray(candidates)) {
    throw new Error('Candidates must be a valid array');
  }

  // 1. Separate candidates by pillar
  const techCandidates = candidates.filter(c => c.pillar === 'tech');
  const skillsCandidates = candidates.filter(c => c.pillar === 'skills');

  // 2. Validate hard constraints
  if (techCandidates.length < 2) {
    throw new Error(`Insufficient tech candidates available. Required exactly 2, but only found ${techCandidates.length}.`);
  }
  if (skillsCandidates.length < 1) {
    throw new Error(`Insufficient skills candidates available. Required exactly 1, but only found ${skillsCandidates.length}.`);
  }

  // 3. Score all candidates
  const scoredTech = techCandidates.map(c => ({ ...c, _score: scoreCandidate(c) }));
  const scoredSkills = skillsCandidates.map(c => ({ ...c, _score: scoreCandidate(c) }));

  // 4. Select Tech Candidates (Exactly 2, preferring variety: 1 recent + 1 evergreen)
  const techRecent = scoredTech.filter(c => c.type === 'recent').sort((a, b) => b._score - a._score);
  const techEvergreen = scoredTech.filter(c => c.type === 'evergreen').sort((a, b) => b._score - a._score);

  let selectedTech = [];
  if (techRecent.length > 0 && techEvergreen.length > 0) {
    // Variety is possible: pick the top 1 from each
    selectedTech.push(techRecent[0]);
    selectedTech.push(techEvergreen[0]);
  } else if (techRecent.length >= 2) {
    // Only recent are available or evergreen is empty
    selectedTech.push(techRecent[0], techRecent[1]);
  } else if (techEvergreen.length >= 2) {
    // Only evergreen are available or recent is empty
    selectedTech.push(techEvergreen[0], techEvergreen[1]);
  } else {
    // Fallback: sort all tech by score descending and take top 2
    const sortedAllTech = scoredTech.sort((a, b) => b._score - a._score);
    selectedTech.push(sortedAllTech[0], sortedAllTech[1]);
  }

  // 5. Select Skills Candidate (Exactly 1, highest scored)
  const sortedSkills = scoredSkills.sort((a, b) => b._score - a._score);
  const selectedSkills = [sortedSkills[0]];

  // 6. Clean up internal _score fields and combine selections
  const finalSelection = [...selectedTech, ...selectedSkills].map(({ _score, ...rest }) => rest);

  return finalSelection;
}

// standalone run block
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('--- STANDALONE TESTING: src/select.js ---');
  console.log('Retrieving candidates from research agent...');

  generateCandidates()
    .then(candidates => {
      console.log(`Retrieved ${candidates.length} candidates.`);
      console.log('Selecting topics (2 tech + 1 skills)...');
      
      const selected = selectTopics(candidates);
      console.log('\n--- Selected Topics for Human Approval ---');
      console.log(JSON.stringify(selected, null, 2));
    })
    .catch(err => {
      console.error('Failed standalone selection run:', err);
    });
}
