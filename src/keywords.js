// Deliverable: SEO keyword taxonomy
// Manually populated from Semrush Keyword Magic Tool (free tier).
// Structured by pillar -> cluster to align with the Deliverable 6 tagging work.
// Refresh cadence: monthly manual pull, since free tier has no API access.
//
// Audience coverage: each cluster mixes B2C (individual course-seekers) and B2B
// (employers buying team/corporate training, SDL recovery, B-BBEE scorecard
// points) intent, so a single dual-audience post can target both. Entries
// tagged "B2B — to confirm" are candidate terms added ahead of the next
// free-tier SemRush pull; verify/trim their volumes on that pull.

export const keywords = {
  tech: {
    ai: [
      "ai courses in south africa",
      "ai courses south africa",
      "ai short courses south africa",
      "ai training for business south africa"            // B2B — to confirm
    ],
    cybersecurity: [
      "cyber security courses south africa",
      "cyber security short courses in south africa",
      "corporate cybersecurity training south africa"    // B2B — to confirm
    ],
    data: [
      "data science course south africa",
      "data science online course south africa",
      "data analytics training for business south africa" // B2B — to confirm
    ],
    ux: [
      "ux design course south africa",
      "ui ux design course south africa"
    ],
    software: [
      "coding bootcamps south africa",
      "free coding bootcamp south africa",
      "corporate software development training south africa" // B2B — to confirm
    ],
  },
  skills: {
    // Skills-development pillar is inherently B2B: these are the searches an
    // employer / HR / L&D buyer runs around B-BBEE, SDL recovery and SETA/QCTO
    // compliance. Candidate terms — confirm volumes on the next SemRush pull.
    bbbee: [
      "b-bbee skills development",                        // B2B — to confirm
      "b-bbee skills development points",                 // B2B — to confirm
      "skills development element b-bbee",                // B2B — to confirm
      "bbbee scorecard skills development",               // B2B — to confirm
      "employment equity training south africa"           // B2B — to confirm
    ],
    learnerships: [
      "learnerships in south africa",        // vol 170, KD 24%, intent: commercial
      "available learnerships in south africa", // vol 90, KD 25%, intent: commercial
      "host a learnership south africa"      // B2B — to confirm
    ],
    'skills-development': [
      "skills development levy",                          // B2B — to confirm
      "sdl claim back south africa",                      // B2B — to confirm
      "workplace skills plan",                            // B2B — to confirm
      "corporate training providers south africa",        // B2B — to confirm
      "employee upskilling south africa",                 // B2B — to confirm
      "qcto accredited training providers"                // B2B — to confirm (brand-aligned; avoids the QCTO-only rule conflict)
    ]
  }
};

// Cluster-classification patterns, scoped per pillar. Each cluster key MUST
// match a cluster key under `keywords` above so classification and keyword
// lookup stay in sync. ORDER MATTERS: on a scoring tie the earlier cluster wins,
// so more specific clusters are listed before broad ones — e.g. `cybersecurity`
// before `software` so "cloud security" routes to cybersecurity, and `ai` is
// last so "AI data centre" routes to data rather than the broad "ai" match.
const CLUSTER_PATTERNS = {
  tech: [
    ['cybersecurity', /\b(cyber\w*|security|infosec|phishing|ransomware|malware|threats?|breach\w*|hacker\w*|vpn|passwords?|encryption|cryptograph\w*|quantum[- ]?safe|zero[- ]?trust|identity management|firewall|soc|cyberattacks?)\b/i],
    ['data', /\b(data science|data analytics|data engineer\w*|data governance|data cent(?:re|er)|analytics|big data|databases?|sql|business intelligence|dashboards?)\b/i],
    ['ux', /\b(ux|ui|user experience|user interface|usability|product design|interaction design|figma|wireframes?)\b/i],
    ['software', /\b(software|coding|programming|developers?|web development|full[- ]?stack|devops|bootcamps?|python|javascript|cloud computing)\b/i],
    ['ai', /\b(ai|a\.i\.|artificial intelligence|machine learning|ml|gen[- ]?ai|generative|llms?|large language models?|chatbots?|gpt|neural networks?)\b/i],
  ],
  skills: [
    ['bbbee', /\b(b-?bbee|bbbee|bee|broad[- ]?based black|scorecard|employment equity|ee targets?|transformation)\b/i],
    ['learnerships', /\b(learnerships?|internships?|apprenticeships?|work[- ]?integrated|workplace experience|youth employment|graduate programmes?)\b/i],
    ['skills-development', /\b(skills development|skills levy|sdl|setas?|qcto|wsp|atr|upskilling|reskilling|nqf|workplace skills plan|occupational qualifications?|skills gap)\b/i],
  ],
};

/**
 * Infers a topic's cluster from its text, scoped to the topic's pillar so a
 * tech topic can only resolve to a tech cluster (and likewise for skills).
 * Title matches count double (a keyword in the title is a stronger signal than
 * one in the pitch/notes). Returns the highest-scoring cluster, or null when
 * nothing matches (the caller then falls back to the flattened pillar list).
 *
 * @param {object} topic Topic object, expects at least { pillar, title? }
 * @returns {string|null} A cluster key under keywords[pillar], or null
 */
export function classifyCluster(topic) {
  if (!topic || !topic.pillar) return null;
  const patterns = CLUSTER_PATTERNS[topic.pillar];
  if (!patterns) return null;

  const title = String(topic.title || '');
  const context = [topic.pitch, topic.sourceNotes, topic.sourceTopic]
    .filter(Boolean)
    .join(' ');

  let best = null;
  let bestScore = 0;
  for (const [cluster, rx] of patterns) {
    const g = new RegExp(rx.source, 'gi'); // global clone to count occurrences
    const titleHits = (title.match(g) || []).length;
    const contextHits = (context.match(g) || []).length;
    const score = titleHits * 2 + contextHits;
    // Strict `>` means a tie keeps the earlier (higher-priority) cluster.
    if (score > bestScore) {
      bestScore = score;
      best = cluster;
    }
  }
  return best;
}

/**
 * Returns the relevant keywords for a given topic, routed to its cluster.
 *
 * Resolution order:
 *   1. An explicit, valid topic.cluster (once cluster tagging is persisted), else
 *   2. a cluster inferred from the topic text via classifyCluster().
 * A resolved cluster returns ONLY that cluster's keywords — even if that array
 * is currently empty — so a post is never diluted with another cluster's terms
 * (an empty cluster simply surfaces no keywords rather than the wrong ones).
 * Only when no cluster can be determined do we fall back to the flattened
 * pillar list (the previous behaviour).
 *
 * @param {object} topic Topic object, expects at least { pillar, title?, cluster? }
 * @param {number} limit Max number of keywords to return (default 8)
 * @returns {string[]}
 */
export function getKeywordsForTopic(topic, limit = 8) {
  if (!topic || !topic.pillar || !keywords[topic.pillar]) return [];

  const pillarKeywords = keywords[topic.pillar];

  const explicit =
    topic.cluster && pillarKeywords[topic.cluster] !== undefined ? topic.cluster : null;
  const cluster = explicit || classifyCluster(topic);

  if (cluster && pillarKeywords[cluster] !== undefined) {
    return pillarKeywords[cluster].slice(0, limit);
  }

  const flattened = Object.values(pillarKeywords).flat();
  return flattened.slice(0, limit);
}