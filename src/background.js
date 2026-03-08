const OPENALEX_BASE = 'https://api.openalex.org/works';
const CROSSREF_BASE = 'https://api.crossref.org/works';

const SCORE = {
  TITLE: 0.45,
  YEAR: 0.15,
  AUTHORS: 0.2,
  CONTAINER: 0.1,
  DOI: 0.1,
  MIN_ACCEPT: 0.55,
  DOI_EXACT_BOOST: 1.2
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SUPER_CITE_FETCH') return;

  enrichAndFormat(message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function enrichAndFormat(seed) {
  const seedClean = normalizeSeed(seed);
  const seedDoi = extractDoi([seedClean.title, seedClean.metaRaw, seedClean.sourceUrl].join(' '));

  const candidates = [];

  if (seedDoi) {
    const [oaByDoi, crByDoi] = await Promise.allSettled([
      fetchOpenAlexByDoi(seedDoi),
      fetchCrossrefByDoi(seedDoi)
    ]);
    pushSettled(candidates, oaByDoi);
    pushSettled(candidates, crByDoi);
  }

  const [oaBySearch, crBySearch] = await Promise.allSettled([
    searchOpenAlex(seedClean),
    searchCrossref(seedClean)
  ]);
  pushSettled(candidates, oaBySearch);
  pushSettled(candidates, crBySearch);

  const best = pickBestCandidate(seedClean, candidates, seedDoi);
  const accepted = best && (best.score >= SCORE.MIN_ACCEPT || best.matchType === 'doi-exact');
  const record = mergeRecord(seedClean, accepted ? best.record : {});

  return {
    record,
    formats: {
      apa: formatAPA(record),
      mla: formatMLA(record),
      chicago: formatChicago(record),
      ieee: formatIEEE(record),
      gbt7714_numeric: formatGBT7714Numeric(record),
      gbt7714_author_year: formatGBT7714AuthorYear(record),
      bibtex: formatBibTeX(record),
      ris: formatRIS(record)
    },
    note: buildNote(best, accepted)
  };
}

function buildNote(best, accepted) {
  if (!best) {
    return {
      text: 'Metadata source: Scholar only (no external match found).',
      sourceUrl: ''
    };
  }
  if (!accepted) {
    return {
      text: `Metadata source: Scholar only (best external match below threshold ${SCORE.MIN_ACCEPT}).`,
      sourceUrl: ''
    };
  }
  return {
    text: `Metadata source: ${best.source} (${best.matchType}).`,
    sourceUrl: cleanText(best.sourceUrl || best.record?.sourceRecordUrl)
  };
}

function normalizeSeed(seed) {
  return {
    title: cleanText(seed?.title),
    authors: Array.isArray(seed?.authors) ? seed.authors : [],
    year: cleanText(seed?.year),
    container: cleanText(seed?.container),
    sourceUrl: cleanText(seed?.sourceUrl),
    metaRaw: cleanText(seed?.metaRaw)
  };
}

function pushSettled(target, settledResult) {
  if (settledResult.status !== 'fulfilled' || !settledResult.value) return;
  const value = settledResult.value;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && item.record) target.push(item);
    }
    return;
  }
  if (value.record) target.push(value);
}

async function fetchOpenAlexByDoi(doi) {
  const url = `${OPENALEX_BASE}/https://doi.org/${encodeURIComponent(doi)}`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const item = await response.json();
  const record = normalizeOpenAlex(item);
  return {
    source: 'OpenAlex DOI',
    matchType: 'doi-exact',
    sourceUrl: cleanText(record.sourceRecordUrl),
    record
  };
}

async function fetchCrossrefByDoi(doi) {
  const url = `${CROSSREF_BASE}/${encodeURIComponent(doi)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  const item = await response.json();
  const record = normalizeCrossref(item?.message);
  return {
    source: 'Crossref DOI',
    matchType: 'doi-exact',
    sourceUrl: cleanText(record.sourceRecordUrl),
    record
  };
}

async function searchOpenAlex(seed) {
  const query = encodeURIComponent(seed.title || `${seed.container} ${seed.year}`.trim());
  const url = `${OPENALEX_BASE}?search=${query}&per-page=5`;
  const response = await fetch(url);
  if (!response.ok) return [];

  const data = await response.json();
  return (data?.results || []).map((item) => {
    const record = normalizeOpenAlex(item);
    return {
      source: 'OpenAlex search',
      matchType: 'search',
      sourceUrl: cleanText(record.sourceRecordUrl),
      record
    };
  });
}

async function searchCrossref(seed) {
  const query = encodeURIComponent(seed.title || `${seed.container} ${seed.year}`.trim());
  const url = `${CROSSREF_BASE}?query.bibliographic=${query}&rows=5`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];

  const data = await response.json();
  return (data?.message?.items || []).map((item) => {
    const record = normalizeCrossref(item);
    return {
      source: 'Crossref search',
      matchType: 'search',
      sourceUrl: cleanText(record.sourceRecordUrl),
      record
    };
  });
}

function pickBestCandidate(seed, candidates, seedDoi) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  let best = null;
  for (const candidate of candidates) {
    if (!candidate?.record) continue;
    const score = scoreCandidate(seed, candidate.record, seedDoi, candidate.matchType);
    const withScore = { ...candidate, score };
    if (!best || withScore.score > best.score) {
      best = withScore;
    }
  }
  return best;
}

function scoreCandidate(seed, rec, seedDoi, matchType) {
  let score = 0;

  const titleScore = titleSimilarity(seed.title, rec.title);
  const yearScore = yearSimilarity(seed.year, rec.year);
  const authorScore = authorSimilarity(seed.authors, rec.authors);
  const containerScore = containerSimilarity(seed.container, rec.container);
  const doiScore = doiSimilarity(seedDoi, rec.doi);

  score += titleScore * SCORE.TITLE;
  score += yearScore * SCORE.YEAR;
  score += authorScore * SCORE.AUTHORS;
  score += containerScore * SCORE.CONTAINER;
  score += doiScore * SCORE.DOI;

  if (matchType === 'doi-exact' && doiScore === 1) {
    score += SCORE.DOI_EXACT_BOOST;
  }

  if (!rec.title || !rec.authors?.length) {
    score -= 0.08;
  }

  return Math.max(0, score);
}

function mergeRecord(seed, rec) {
  const merged = {
    title: rec.title || seed.title || '',
    authors: rec.authors?.length ? rec.authors : normalizeSeedAuthors(seed.authors),
    year: rec.year || seed.year || '',
    container: rec.container || seed.container || '',
    volume: rec.volume || '',
    issue: rec.issue || '',
    page: rec.page || '',
    publisher: rec.publisher || '',
    doi: rec.doi || extractDoi([seed.metaRaw, seed.sourceUrl].join(' ')) || '',
    url: rec.url || seed.sourceUrl || '',
    type: rec.type || 'article-journal'
  };

  if (!merged.url && merged.doi) merged.url = `https://doi.org/${merged.doi}`;
  return merged;
}

function normalizeOpenAlex(item) {
  if (!item) return {};

  const location = item.primary_location || {};
  const source = location.source || {};
  return {
    title: cleanText(item.title),
    authors: (item.authorships || []).map((authorship) => ({
      given: pickGivenName(authorship.author?.display_name),
      family: pickFamilyName(authorship.author?.display_name)
    })),
    year: item.publication_year ? String(item.publication_year) : '',
    container: cleanText(source.display_name),
    volume: cleanText(item.biblio?.volume),
    issue: cleanText(item.biblio?.issue),
    page: joinPages(item.biblio?.first_page, item.biblio?.last_page),
    publisher: cleanText(source.host_organization_name),
    doi: normalizeDoi(item.doi),
    url: item.doi || location.landing_page_url || '',
    sourceRecordUrl: cleanText(item.id),
    type: mapType(item.type)
  };
}

function normalizeCrossref(item) {
  if (!item) return {};

  const title = Array.isArray(item.title) ? item.title[0] : '';
  const container = Array.isArray(item['container-title']) ? item['container-title'][0] : '';
  return {
    title: cleanText(title),
    authors: (item.author || []).map((author) => ({
      given: cleanText(author.given),
      family: cleanText(author.family)
    })),
    year: extractYearFromCrossref(item),
    container: cleanText(container),
    volume: cleanText(item.volume),
    issue: cleanText(item.issue),
    page: cleanText(item.page),
    publisher: cleanText(item.publisher),
    doi: normalizeDoi(item.DOI),
    url: cleanText(item.URL),
    sourceRecordUrl: buildCrossrefRecordUrl(item),
    type: mapCrossrefType(item.type)
  };
}

function buildCrossrefRecordUrl(item) {
  const doi = normalizeDoi(item?.DOI);
  if (!doi) return '';
  return `${CROSSREF_BASE}/${encodeURIComponent(doi)}`;
}

function extractYearFromCrossref(item) {
  const candidates = [
    item?.published?.['date-parts']?.[0]?.[0],
    item?.issued?.['date-parts']?.[0]?.[0],
    item?.created?.['date-parts']?.[0]?.[0]
  ];
  for (const year of candidates) {
    if (year) return String(year);
  }
  return '';
}

function mapType(type) {
  if (!type) return 'article-journal';
  if (type.includes('book')) return 'book';
  if (type.includes('proceedings')) return 'paper-conference';
  return 'article-journal';
}

function mapCrossrefType(type) {
  switch (type) {
    case 'book':
    case 'monograph':
      return 'book';
    case 'proceedings-article':
      return 'paper-conference';
    default:
      return 'article-journal';
  }
}

function normalizeSeedAuthors(authors) {
  return (authors || []).map((author) => {
    const raw = cleanText(author?.raw);
    if (!raw) return { given: '', family: '' };

    const parts = raw.split(/\s+/);
    if (parts.length < 2) return { given: '', family: raw };

    return {
      given: parts.slice(0, -1).join(' '),
      family: parts[parts.length - 1]
    };
  }).filter((author) => author.given || author.family);
}

// Targets APA 7th journal-reference style in plain text output.
function formatAPA(rec) {
  const parts = [];
  const authorsText = formatAuthorsAPA(rec.authors);
  const yearText = `(${rec.year || 'n.d.'}).`;
  const titleText = rec.title ? `${toSentenceCase(rec.title)}.` : '';

  parts.push(`${authorsText} ${yearText}`);
  if (titleText) parts.push(titleText);

  const sourceSegment = buildApaSourceSegment(rec);
  if (sourceSegment) parts.push(sourceSegment);

  if (rec.doi) parts.push(`https://doi.org/${rec.doi}`);
  else if (rec.url) parts.push(rec.url);

  return joinCitationParts(parts);
}

function formatMLA(rec) {
  const parts = [];
  const authorsText = formatAuthorsMLA(rec.authors);
  const titleText = rec.title ? `"${smartTitleCase(rec.title)}."` : '';
  const containerText = buildMlaContainerSegment(rec);

  if (authorsText) parts.push(`${authorsText}.`);
  if (titleText) parts.push(titleText);
  if (containerText) parts.push(containerText);

  if (rec.doi) parts.push(`https://doi.org/${rec.doi}.`);
  else if (rec.url) parts.push(`${rec.url}.`);

  return joinCitationParts(parts);
}

function formatChicago(rec) {
  const parts = [];
  parts.push(`${formatAuthorsChicago(rec.authors)}.`);
  parts.push(`${rec.year || 'n.d.'}.`);
  if (rec.title) parts.push(`"${smartTitleCase(rec.title)}."`);

  let container = '';
  if (rec.container) container += smartTitleCase(rec.container);
  if (rec.volume) container += ` ${rec.volume}`;
  if (rec.issue) container += ` (${rec.issue})`;
  if (rec.page) container += `: ${normalizePageRange(rec.page)}`;
  if (container) parts.push(`${container}.`);

  if (rec.doi) parts.push(`https://doi.org/${rec.doi}.`);
  else if (rec.url) parts.push(`${rec.url}.`);

  return joinCitationParts(parts);
}

function formatIEEE(rec) {
  const segments = [];
  segments.push(`${formatAuthorsIEEE(rec.authors)},`);
  if (rec.title) segments.push(`"${toSentenceCase(rec.title)},"`);
  if (rec.container) segments.push(`${smartTitleCase(rec.container)},`);
  if (rec.volume) segments.push(`vol. ${rec.volume},`);
  if (rec.issue) segments.push(`no. ${rec.issue},`);
  if (rec.page) segments.push(`pp. ${normalizePageRange(rec.page)},`);
  if (rec.year) segments.push(`${rec.year},`);

  if (rec.doi) segments.push(`doi: ${rec.doi}.`);
  else if (rec.url) segments.push(`${rec.url}.`);

  return cleanPunctuation(segments.join(' '));
}

function formatGBT7714Numeric(rec) {
  return formatGBT7714(rec, { numbered: true });
}

function formatGBT7714AuthorYear(rec) {
  return formatGBT7714(rec, { numbered: false });
}

function formatGBT7714(rec, options = {}) {
  const parts = [];
  if (options.numbered) parts.push('[1]');
  parts.push(`${formatAuthorsGBT(rec.authors)}.`);

  if (rec.title) {
    parts.push(`${toSentenceCase(rec.title)}[${mapGbtRefType(rec.type)}].`);
  }

  const sourceSegment = buildGbtSourceSegment(rec);
  if (sourceSegment) parts.push(sourceSegment);

  const accessSegment = buildGbtAccessSegment(rec);
  if (accessSegment) parts.push(accessSegment);

  return joinCitationParts(parts);
}

function formatBibTeX(rec) {
  const entryType = rec.type === 'book' ? 'book' : rec.type === 'paper-conference' ? 'inproceedings' : 'article';
  const key = buildBibtexKey(rec);

  const lines = [
    `@${entryType}{${key},`,
    `  title = {${escapeBraces(rec.title)}},`,
    `  author = {${rec.authors.map((author) => `${author.family}, ${author.given}`.trim().replace(/^,\s*/, '')).join(' and ')}},`,
    rec.container ? `  ${entryType === 'inproceedings' ? 'booktitle' : 'journal'} = {${escapeBraces(rec.container)}},` : '',
    rec.year ? `  year = {${rec.year}},` : '',
    rec.volume ? `  volume = {${rec.volume}},` : '',
    rec.issue ? `  number = {${rec.issue}},` : '',
    rec.page ? `  pages = {${normalizePageRange(rec.page)}},` : '',
    rec.publisher ? `  publisher = {${escapeBraces(rec.publisher)}},` : '',
    rec.doi ? `  doi = {${rec.doi}},` : '',
    rec.url ? `  url = {${rec.url}},` : '',
    '}'
  ].filter(Boolean);

  return lines.join('\n');
}

function formatRIS(rec) {
  const typeMap = {
    'article-journal': 'JOUR',
    book: 'BOOK',
    'paper-conference': 'CPAPER'
  };

  const risType = typeMap[rec.type] || 'JOUR';
  const lines = [`TY  - ${risType}`];

  rec.authors.forEach((author) => {
    lines.push(`AU  - ${fullName(author)}`);
  });

  if (rec.title) lines.push(`TI  - ${rec.title}`);
  if (rec.container) lines.push(`JO  - ${rec.container}`);
  if (rec.year) lines.push(`PY  - ${rec.year}`);
  if (rec.volume) lines.push(`VL  - ${rec.volume}`);
  if (rec.issue) lines.push(`IS  - ${rec.issue}`);

  const pages = splitPageRange(rec.page);
  if (pages.start) lines.push(`SP  - ${pages.start}`);
  if (pages.end) lines.push(`EP  - ${pages.end}`);

  if (rec.publisher) lines.push(`PB  - ${rec.publisher}`);
  if (rec.doi) lines.push(`DO  - ${rec.doi}`);
  if (rec.url) lines.push(`UR  - ${rec.url}`);

  lines.push('ER  -');
  return lines.join('\n');
}

function formatAuthorsAPA(authors) {
  if (!authors?.length) return 'Unknown Author';

  const mapped = authors.map((author) => {
    const family = cleanText(author.family);
    const initials = initialsFromGiven(author.given, true);
    return cleanText(`${family}, ${initials}`).replace(/,$/, '');
  }).filter(Boolean);

  if (mapped.length === 1) return mapped[0];
  if (mapped.length <= 20) return `${mapped.slice(0, -1).join(', ')}, & ${mapped[mapped.length - 1]}`;
  return `${mapped.slice(0, 19).join(', ')}, ..., ${mapped[mapped.length - 1]}`;
}

function formatAuthorsMLA(authors) {
  if (!authors?.length) return 'Unknown Author';
  if (authors.length === 1) return invertName(authors[0]);
  if (authors.length === 2) return `${invertName(authors[0])}, and ${fullName(authors[1])}`;
  return `${invertName(authors[0])}, et al`;
}

function formatAuthorsChicago(authors) {
  if (!authors?.length) return 'Unknown Author';
  if (authors.length === 1) return invertName(authors[0]);
  if (authors.length === 2) return `${invertName(authors[0])} and ${fullName(authors[1])}`;
  return `${invertName(authors[0])} et al`;
}

function formatAuthorsIEEE(authors) {
  if (!authors?.length) return 'Unknown Author';

  const names = authors.map((author) => {
    const initials = initialsFromGiven(author.given, false);
    return cleanText(`${initials} ${author.family}`);
  }).filter(Boolean);

  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function formatAuthorsGBT(authors) {
  if (!authors?.length) return 'Unknown Author';

  const names = authors.map((author) => {
    const family = cleanText(author.family);
    const given = cleanText(author.given);
    const merged = cleanText(`${family}${given}`);

    if (containsCjk(merged)) {
      return merged || cleanText(fullName(author));
    }

    const initials = initialsFromGiven(given, true).replace(/\./g, '');
    return cleanText(`${family} ${initials}`).replace(/\s+/g, ' ');
  }).filter(Boolean);

  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')}, et al`;
}

function mapGbtRefType(type) {
  if (type === 'book') return 'M';
  if (type === 'paper-conference') return 'C';
  return 'J';
}

function buildGbtSourceSegment(rec) {
  if (rec.type === 'book') {
    const pieces = [];
    if (rec.publisher) pieces.push(rec.publisher);
    if (rec.year) pieces.push(rec.year);
    return pieces.length ? `${pieces.join(', ')}.` : '';
  }

  const pieces = [];
  if (rec.container) pieces.push(rec.container);
  if (rec.year) pieces.push(rec.year);

  if (rec.type === 'article-journal') {
    if (rec.volume && rec.issue) {
      pieces.push(`${rec.volume}(${rec.issue})`);
    } else if (rec.volume) {
      pieces.push(rec.volume);
    } else if (rec.issue) {
      pieces.push(`(${rec.issue})`);
    }
  }

  let text = pieces.join(', ');
  if (rec.page) {
    const pages = normalizePageRange(rec.page);
    if (pages) {
      text = text ? `${text}: ${pages}` : pages;
    }
  }

  return text ? `${text}.` : '';
}

function buildGbtAccessSegment(rec) {
  if (rec.doi) return `DOI: ${rec.doi}.`;
  if (rec.url) return rec.url;
  return '';
}

function extractDoi(input) {
  if (!input) return '';
  const match = input.match(/10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/i);
  return match ? normalizeDoi(match[0]) : '';
}

function normalizeDoi(doi) {
  return cleanText(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
}

function buildBibtexKey(rec) {
  const firstFamily = rec.authors?.[0]?.family || 'unknown';
  const year = rec.year || 'nd';
  const firstWord = cleanText(rec.title || 'work').split(/\s+/)[0] || 'work';
  return `${slug(firstFamily)}${year}${slug(firstWord)}`;
}

function slug(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
}

function invertName(author) {
  return cleanText(`${author.family || ''}, ${author.given || ''}`).replace(/,$/, '');
}

function fullName(author) {
  return cleanText(`${author.given || ''} ${author.family || ''}`);
}

function pickGivenName(displayName) {
  const parts = cleanText(displayName).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return '';
  return parts.slice(0, -1).join(' ');
}

function pickFamilyName(displayName) {
  const parts = cleanText(displayName).split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function normalizeName(name) {
  return cleanText(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function containsCjk(text) {
  return /[\u3400-\u9FFF]/.test(cleanText(text));
}

function joinPages(first, last) {
  const a = cleanText(first);
  const b = cleanText(last);
  if (a && b) return `${a}-${b}`;
  return a || b || '';
}

function normalizePageRange(page) {
  const pages = splitPageRange(page);
  if (pages.start && pages.end) return `${pages.start}-${pages.end}`;
  return pages.start || '';
}

function splitPageRange(page) {
  const raw = cleanText(page);
  if (!raw) return { start: '', end: '' };

  const match = raw.match(/^([A-Za-z]?\d+)[\s\-–—]+([A-Za-z]?\d+)$/);
  if (match) return { start: match[1], end: match[2] };

  return { start: raw, end: '' };
}

function toSentenceCase(text) {
  const raw = cleanText(text);
  if (!raw) return '';
  return raw[0].toUpperCase() + raw.slice(1);
}

function buildApaSourceSegment(rec) {
  if (!rec.container && !rec.volume && !rec.issue && !rec.page) return '';

  const pieces = [];
  if (rec.container) pieces.push(smartTitleCase(rec.container));

  if (rec.volume && rec.issue) {
    pieces.push(`${rec.volume}(${rec.issue})`);
  } else if (rec.volume) {
    pieces.push(rec.volume);
  } else if (rec.issue) {
    pieces.push(`(${rec.issue})`);
  }

  if (rec.page) pieces.push(normalizePageRange(rec.page));
  return `${pieces.join(', ')}.`;
}

function buildMlaContainerSegment(rec) {
  const pieces = [];
  if (rec.container) pieces.push(smartTitleCase(rec.container));
  if (rec.volume) pieces.push(`vol. ${rec.volume}`);
  if (rec.issue) pieces.push(`no. ${rec.issue}`);
  if (rec.year) pieces.push(rec.year);
  if (rec.page) pieces.push(`pp. ${normalizePageRange(rec.page)}`);

  if (!pieces.length) return '';
  return `${pieces.join(', ')}.`;
}

function smartTitleCase(text) {
  const stopwords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via', 'with'
  ]);

  const words = cleanText(text).split(' ').filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index !== 0 && index !== words.length - 1 && stopwords.has(lower)) {
        return lower;
      }
      if (/^[A-Z0-9\-]+$/.test(word) && word.length > 1) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function titleSimilarity(a, b) {
  const ta = normalizeName(a);
  const tb = normalizeName(b);
  if (!ta || !tb) return 0;

  const aWords = new Set(ta.split(/\s+/).filter(Boolean));
  const bWords = new Set(tb.split(/\s+/).filter(Boolean));
  const intersection = [...aWords].filter((word) => bWords.has(word)).length;
  const union = new Set([...aWords, ...bWords]).size;
  return union ? intersection / union : 0;
}

function yearSimilarity(seedYear, recYear) {
  if (!seedYear || !recYear) return 0;
  const diff = Math.abs(Number(seedYear) - Number(recYear));
  if (diff === 0) return 1;
  if (diff === 1) return 0.6;
  if (diff === 2) return 0.2;
  return 0;
}

function authorSimilarity(seedAuthors, recAuthors) {
  const seedFamilies = new Set(extractFamilyNames(seedAuthors, true));
  const recFamilies = new Set(extractFamilyNames(recAuthors, false));

  if (!seedFamilies.size || !recFamilies.size) return 0;

  const overlap = [...seedFamilies].filter((family) => recFamilies.has(family)).length;
  const denominator = Math.max(seedFamilies.size, recFamilies.size);
  return denominator ? overlap / denominator : 0;
}

function extractFamilyNames(authors, isSeed) {
  if (!Array.isArray(authors)) return [];

  return authors
    .slice(0, 4)
    .map((author) => {
      if (isSeed) {
        const raw = normalizeName(author?.raw || '');
        if (!raw) return '';
        const parts = raw.split(/\s+/);
        return parts[parts.length - 1] || '';
      }
      return normalizeName(author?.family || fullName(author));
    })
    .filter(Boolean);
}

function containerSimilarity(seedContainer, recContainer) {
  if (!seedContainer || !recContainer) return 0;
  return titleSimilarity(seedContainer, recContainer);
}

function doiSimilarity(seedDoi, recDoi) {
  const a = normalizeDoi(seedDoi);
  const b = normalizeDoi(recDoi);
  if (!a || !b) return 0;
  return a === b ? 1 : 0;
}

function initialsFromGiven(given, withSpaces) {
  const initials = cleanText(given)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `${token[0].toUpperCase()}.`);
  return withSpaces ? initials.join(' ') : initials.join(' ');
}

function joinCitationParts(parts) {
  return cleanPunctuation(parts.filter(Boolean).join(' '));
}

function cleanPunctuation(text) {
  return cleanText(text)
    .replace(/\s+,/g, ',')
    .replace(/\s+\./g, '.')
    .replace(/\.\./g, '.')
    .replace(/,\./g, '.')
    .replace(/\s+:/g, ':')
    .replace(/\s+;/g, ';');
}

function escapeBraces(text) {
  return String(text || '').replace(/[{}]/g, '');
}
