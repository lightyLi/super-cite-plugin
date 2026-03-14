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
  if (!message?.type) return;

  if (message.type === 'SUPER_CITE_FETCH') {
    enrichAndFormat(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'SUPER_CITE_FETCH_FROM_TAB') {
    fetchCitationFromTab(message.tabId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return undefined;
});

async function fetchCitationFromTab(tabId) {
  const seed = await extractPageSeedFromTab(tabId);
  return enrichAndFormat(seed);
}

async function extractPageSeedFromTab(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const byName = (name) => clean(document.querySelector(`meta[name="${name}"]`)?.getAttribute('content'));
      const byProp = (prop) => clean(document.querySelector(`meta[property="${prop}"]`)?.getAttribute('content'));
      const collectByName = (name) => Array.from(document.querySelectorAll(`meta[name="${name}"]`))
        .map((el) => clean(el.getAttribute('content')))
        .filter(Boolean);
      const collectByProp = (prop) => Array.from(document.querySelectorAll(`meta[property="${prop}"]`))
        .map((el) => clean(el.getAttribute('content')))
        .filter(Boolean);
      const textFromSelectors = (selectors) => {
        for (const selector of selectors) {
          const value = clean(document.querySelector(selector)?.textContent);
          if (value) return value;
        }
        return '';
      };
      const attrFromSelectors = (selectors, attr) => {
        for (const selector of selectors) {
          const value = clean(document.querySelector(selector)?.getAttribute(attr));
          if (value) return value;
        }
        return '';
      };
      const extractDateIso = (raw) => {
        const text = clean(raw);
        if (!text) return '';
        const match = text.match(/\b((19|20)\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/);
        if (match) return `${match[1]}-${match[3]}-${match[4]}`;
        const parsed = Date.parse(text);
        if (!Number.isNaN(parsed)) {
          const dt = new Date(parsed);
          const y = dt.getUTCFullYear();
          const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
          const d = String(dt.getUTCDate()).padStart(2, '0');
          return `${y}-${m}-${d}`;
        }
        return '';
      };
      const yearFromText = (text) => {
        const match = clean(text).match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : '';
      };
      const extractDoi = (text) => {
        const match = clean(text).match(/10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/i);
        return match ? match[0] : '';
      };
      const unique = (items) => [...new Set((items || []).map((item) => clean(item)).filter(Boolean))];
      const normalizeJsonLdAuthor = (author) => {
        if (!author) return [];
        if (Array.isArray(author)) {
          return author.flatMap((item) => normalizeJsonLdAuthor(item));
        }
        if (typeof author === 'string') return [clean(author)];
        if (typeof author === 'object') {
          const name = clean(author.name || author.alternateName || '');
          return name ? [name] : [];
        }
        return [];
      };
      const collectJsonLdArticleNodes = () => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        const nodes = [];

        for (const script of scripts) {
          const raw = clean(script.textContent);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
            while (stack.length) {
              const item = stack.pop();
              if (!item || typeof item !== 'object') continue;
              if (Array.isArray(item)) {
                stack.push(...item);
                continue;
              }
              if (item['@graph'] && Array.isArray(item['@graph'])) {
                stack.push(...item['@graph']);
              }
              const type = Array.isArray(item['@type']) ? item['@type'].join(',') : String(item['@type'] || '');
              if (/article|newsarticle|blogposting/i.test(type)) {
                nodes.push(item);
              }
            }
          } catch (_error) {
            // Ignore invalid JSON-LD blocks.
          }
        }
        return nodes;
      };

      const host = location.hostname.toLowerCase();
      const sourceUrl = location.href;
      const jsonLdArticles = collectJsonLdArticleNodes();

      const jsonLdTitle = clean(jsonLdArticles.find((item) => item.headline)?.headline || '');
      const jsonLdAuthors = unique(jsonLdArticles.flatMap((item) => normalizeJsonLdAuthor(item.author)));
      const jsonLdDate = extractDateIso(
        jsonLdArticles.find((item) => item.datePublished)?.datePublished ||
        jsonLdArticles.find((item) => item.dateCreated)?.dateCreated ||
        ''
      );
      const jsonLdSite = clean(
        jsonLdArticles.find((item) => item.publisher?.name)?.publisher?.name ||
        jsonLdArticles.find((item) => item.isPartOf?.name)?.isPartOf?.name ||
        ''
      );

      const title =
        byName('citation_title') ||
        byName('dc.title') ||
        jsonLdTitle ||
        byProp('og:title') ||
        clean(document.title);

      let authorNames = [
        ...collectByName('citation_author'),
        ...collectByName('dc.creator'),
        ...collectByProp('article:author'),
        ...jsonLdAuthors,
        ...collectByName('author')
      ].filter(Boolean);
      let dateRaw =
        byName('citation_publication_date') ||
        byName('citation_date') ||
        byName('dc.date') ||
        byProp('article:published_time') ||
        byProp('og:article:published_time') ||
        attrFromSelectors(['time[datetime]', '[itemprop="datePublished"]'], 'datetime') ||
        textFromSelectors(['time[datetime]', 'time[pubdate]', '[itemprop="datePublished"]']) ||
        jsonLdDate ||
        '';
      let date = extractDateIso(dateRaw);

      const urlDateMatch = sourceUrl.match(/\/((19|20)\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])\b/);
      if (!date && urlDateMatch) {
        date = `${urlDateMatch[1]}-${urlDateMatch[3]}-${urlDateMatch[4]}`;
      }

      let year = yearFromText(date) ||
        yearFromText(dateRaw) ||
        yearFromText(sourceUrl);

      let container =
        byName('citation_journal_title') ||
        byName('citation_conference_title') ||
        byName('dc.source') ||
        byName('application-name') ||
        jsonLdSite ||
        byProp('og:site_name') ||
        '';

      // Site-specific fallbacks for common news/blog platforms.
      if (host.includes('medium.com')) {
        authorNames = authorNames.concat([
          textFromSelectors(['a[rel="author"]']),
          attrFromSelectors(['meta[name="author"]'], 'content')
        ]);
        container = container || 'Medium';
      }

      if (host.includes('nytimes.com')) {
        authorNames = authorNames.concat([
          textFromSelectors(['[itemprop="name"]', '[data-testid="byline"]'])
        ]);
      }

      if (host.includes('reuters.com')) {
        authorNames = authorNames.concat([
          textFromSelectors(['[data-testid="Byline"]', '[class*="Byline"]'])
        ]);
      }

      if (host.includes('cnn.com') || host.includes('bbc.com') || host.includes('theguardian.com')) {
        authorNames = authorNames.concat([
          textFromSelectors(['[rel="author"]', '[class*="byline"]', '[data-component="byline-block"]'])
        ]);
      }

      if (host.includes('thehackernews.com')) {
        authorNames = authorNames.concat([
          textFromSelectors(['.author a', '.author'])
        ]);
        dateRaw = dateRaw || textFromSelectors(['.date']);
        date = date || extractDateIso(dateRaw);
        year = year || yearFromText(dateRaw);
        container = container || 'The Hacker News';
      }

      const dedupAuthors = unique(authorNames)
        .map((name) => name.replace(/^by\s+/i, '').trim())
        .filter((name) => {
          const lower = name.toLowerCase();
          if (!lower) return false;
          const containerLower = clean(container).toLowerCase();
          if (containerLower && lower === containerLower) return false;
          if (lower === 'by' || lower === 'staff') return false;
          return true;
        });

      const doiRaw =
        byName('citation_doi') ||
        byName('dc.identifier') ||
        byName('doi') ||
        '';
      const doi = extractDoi(doiRaw);

      const metaRaw = clean(
        [
          title,
          dedupAuthors.join(', '),
          year,
          date,
          container,
          doi,
          sourceUrl
        ].join(' | ')
      );

      return {
        title,
        authors: dedupAuthors.map((raw) => ({ raw })),
        year,
        date,
        container,
        sourceUrl,
        metaRaw
      };
    }
  });

  const seed = result?.[0]?.result;
  if (!seed || !seed.title) {
    throw new Error('Unable to extract metadata from this page.');
  }
  return seed;
}


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
    date: cleanText(seed?.date),
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
    date: rec.date || seed.date || '',
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
  const rawPage = cleanText(item.page);
  const articleNumber = cleanText(item['article-number']);
  return {
    title: cleanText(title),
    authors: (item.author || []).map((author) => ({
      given: cleanText(author.given),
      family: cleanText(author.family)
    })),
    year: extractYearFromCrossref(item),
    date: extractDateFromCrossref(item),
    container: cleanText(container),
    volume: cleanText(item.volume),
    issue: cleanText(item.issue),
    page: normalizePageField(rawPage, articleNumber),
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

function extractDateFromCrossref(item) {
  const parts = [
    item?.published?.['date-parts']?.[0],
    item?.issued?.['date-parts']?.[0],
    item?.created?.['date-parts']?.[0]
  ];
  for (const dateParts of parts) {
    if (!Array.isArray(dateParts) || !dateParts[0]) continue;
    const year = String(dateParts[0]);
    const month = String(dateParts[1] || 1).padStart(2, '0');
    const day = String(dateParts[2] || 1).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
  const expanded = expandRawAuthorNames(authors);

  return expanded.map((rawName) => {
    const raw = cleanText(rawName);
    if (!raw) return { given: '', family: '' };

    if (isLikelyOrganizationAuthor(raw)) {
      return { given: '', family: raw };
    }

    const commaMatch = raw.match(/^([^,]+),\s*(.+)$/);
    if (commaMatch) {
      return {
        given: cleanText(commaMatch[2]),
        family: cleanText(commaMatch[1])
      };
    }

    const parts = raw.split(/\s+/);
    if (parts.length < 2) return { given: '', family: raw };

    return {
      given: parts.slice(0, -1).join(' '),
      family: parts[parts.length - 1]
    };
  }).filter((author) => author.given || author.family);
}

function expandRawAuthorNames(authors) {
  const rawList = (authors || [])
    .map((author) => normalizeAuthorRawText(author?.raw))
    .filter(Boolean);

  const expanded = [];
  for (const raw of rawList) {
    const chunks = splitCompositeAuthorText(raw);
    for (const chunk of chunks) {
      const value = normalizeAuthorRawText(chunk);
      if (value) expanded.push(value);
    }
  }

  return [...new Set(expanded)];
}

function normalizeAuthorRawText(raw) {
  return cleanText(raw)
    .replace(/^written by\s+/i, '')
    .replace(/^by\s+/i, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCompositeAuthorText(raw) {
  const text = cleanText(raw);
  if (!text) return [];
  if (isLikelyOrganizationAuthor(text)) return [text];

  // Common byline delimiters on news/blog pages.
  const parts = text
    .replace(/\s+(?:and|&)\s+/gi, ';')
    .replace(/\s*,\s*(?=[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g, ';')
    .split(/[;|、，]/)
    .map((item) => cleanText(item))
    .filter(Boolean);

  if (!parts.length) return [text];
  if (parts.length === 1) return parts;

  // Avoid over-splitting when fragments are obviously not person names.
  const likelyPersonParts = parts.filter((name) => {
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;
    if (isLikelyOrganizationAuthor(name)) return false;
    return true;
  });

  return likelyPersonParts.length >= 2 ? likelyPersonParts : [text];
}

// Targets APA 7th journal-reference style in plain text output.
function formatAPA(rec) {
  const parts = [];
  const authorsText = formatAuthorsAPA(rec.authors);
  const yearText = `(${formatApaDate(rec)}).`;
  const titleText = rec.title ? `${toSentenceCase(rec.title)}.` : '';

  parts.push(`${authorsText} ${yearText}`);
  if (titleText) parts.push(titleText);

  const sourceSegment = buildApaSourceSegment(rec);
  if (sourceSegment) parts.push(sourceSegment);

  if (rec.doi) parts.push(`https://doi.org/${rec.doi}`);
  else if (rec.url) parts.push(rec.url);

  return joinCitationParts(parts);
}

function formatApaDate(rec) {
  const looksScholarly = Boolean(rec?.doi || rec?.volume || rec?.issue || rec?.page);
  if (looksScholarly) {
    return rec?.year || 'n.d.';
  }
  const fullDate = parseDateParts(rec?.date);
  if (fullDate) {
    const monthName = monthNameEn(fullDate.month);
    if (monthName) return `${fullDate.year}, ${monthName} ${fullDate.day}`;
  }
  return rec?.year || 'n.d.';
}

function parseDateParts(rawDate) {
  const raw = cleanText(rawDate);
  if (!raw) return null;
  const match = raw.match(/^((19|20)\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/);
  if (!match) return null;
  return {
    year: match[1],
    month: Number(match[3]),
    day: Number(match[4])
  };
}

function monthNameEn(month) {
  const names = [
    '',
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];
  return names[month] || '';
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
  if (rec.page) {
    if (isLikelyArticleNumber(rec.page)) segments.push(`Art. no. ${rec.page},`);
    else segments.push(`pp. ${normalizePageRange(rec.page)},`);
  }
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

function isLikelyOrganizationAuthor(rawName) {
  const raw = cleanText(rawName);
  if (!raw) return false;
  if (/[0-9&/]/.test(raw)) return true;
  if (/\b(news|times|post|media|team|staff|agency|press|editorial)\b/i.test(raw)) return true;
  if (/^(the)\b/i.test(raw) && raw.split(/\s+/).length >= 3) return true;
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length > 4) return true;
  return false;
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
  if (pages.start && pages.end && pages.start === pages.end) return pages.start;
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

function normalizePageField(rawPage, articleNumber) {
  const article = cleanText(articleNumber);
  if (article) return article;

  const page = cleanText(rawPage);
  if (!page) return '';

  const sameRange = page.match(/^([A-Za-z]?\d+)\s*[-–—]\s*\1$/);
  if (sameRange) return sameRange[1];
  return page;
}

function isLikelyArticleNumber(value) {
  const text = cleanText(value);
  if (!text) return false;
  if (/^e\d{4,}$/i.test(text)) return true;
  if (/^\d{5,}$/.test(text)) return true;
  return false;
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

  if (rec.page) {
    if (isLikelyArticleNumber(rec.page)) pieces.push(`Article ${rec.page}`);
    else pieces.push(normalizePageRange(rec.page));
  }
  return `${pieces.join(', ')}.`;
}

function buildMlaContainerSegment(rec) {
  const pieces = [];
  if (rec.container) pieces.push(smartTitleCase(rec.container));
  if (rec.volume) pieces.push(`vol. ${rec.volume}`);
  if (rec.issue) pieces.push(`no. ${rec.issue}`);
  if (rec.year) pieces.push(rec.year);
  if (rec.page) {
    if (isLikelyArticleNumber(rec.page)) pieces.push(`article ${rec.page}`);
    else pieces.push(`pp. ${normalizePageRange(rec.page)}`);
  }

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
