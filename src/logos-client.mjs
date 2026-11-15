import { loadSession } from './session.mjs';

const LOGOS_ORIGIN = 'https://app.logos.com';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
};

/**
 * Decodes common XML/HTML named and numeric character entities.
 */
export function decodeEntities(text) {
  if (!text) return '';
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? full;
  });
}

/**
 * Extracts a named XML/HTML attribute value from a tag attribute string.
 */
function getAttr(attrString, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = attrString.match(re);
  return match ? decodeEntities(match[2]) : null;
}

/**
 * Converts Logos RichText XML (search snippets and previews) into clean text,
 * bolding search hit spans when highlightHitMarkers is enabled.
 */
export function cleanRichTextXml(xml, { highlightHits = true } = {}) {
  if (!xml || typeof xml !== 'string') return '';

  const tokenRe = /<(\/?)([A-Za-z0-9:_-]+)([^>]*?)(\/?)>/g;
  const parts = [];
  let inHit = false;
  let lastIndex = 0;

  let match;
  while ((match = tokenRe.exec(xml)) !== null) {
    if (match.index > lastIndex) {
      parts.push(decodeEntities(xml.slice(lastIndex, match.index)));
    }
    lastIndex = tokenRe.lastIndex;

    const isClosing = match[1] === '/';
    const tag = match[2];
    const attrs = match[3] || '';
    const isSelfClosing = match[4] === '/';

    if (tag === 'ResourceSearchHitLink') {
      if (!isClosing && !isSelfClosing) {
        inHit = true;
        if (highlightHits) parts.push('**');
      } else if (isClosing && inHit) {
        if (highlightHits) parts.push('**');
        inHit = false;
      }
      continue;
    }

    if (tag === 'Run' && !isClosing) {
      const runText = getAttr(attrs, 'Text');
      if (runText !== null) {
        parts.push(runText);
      }
      continue;
    }

    if (tag === 'Tab' && !isClosing) {
      parts.push(' ');
      continue;
    }

    if (tag === 'LineBreak' && !isClosing) {
      parts.push('\n');
      continue;
    }

    if (tag === 'Paragraph' && isClosing) {
      parts.push('\n\n');
    }
  }

  if (lastIndex < xml.length) {
    parts.push(decodeEntities(xml.slice(lastIndex)));
  }

  let output = parts.join('');
  if (highlightHits) {
    // Merge single-space adjacent hit words like "**Justification** **by** **faith**"
    output = output.replace(/\*\*( )\*\*/g, '$1');
  }
  return output.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Wraps trimmed inner text with inline Markdown markers without trapping surrounding whitespace.
 */
function wrapInlineMarkdown(inner, marker) {
  const lead = inner.match(/^\s*/)?.[0] || '';
  const trail = inner.match(/\s*$/)?.[0] || '';
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (!core || !/[\p{L}\p{N}]/u.test(core)) {
    return inner;
  }
  return `${lead}${marker}${core}${marker}${trail}`;
}

/**
 * Injects an internal anchor sentinel at the offset-marker closest to targetOffset.
 */
const TARGET_ANCHOR_SENTINEL = '@@LOGOS_OFFSET_ANCHOR@@';

function injectOffsetAnchor(html, targetOffset) {
  if (targetOffset === undefined || targetOffset === null || Number.isNaN(Number(targetOffset))) {
    return html;
  }
  const target = Number(targetOffset);
  const markers = [];
  const markerRe = /<span\b([^>]*)>\s*<\/span>/gi;
  let match;
  while ((match = markerRe.exec(html)) !== null) {
    const attrs = match[1] || '';
    const cls = getAttr(attrs, 'class') || '';
    const rawOff = getAttr(attrs, 'data-offset');
    if (cls.includes('offset-marker') && rawOff !== null && /^\d+$/.test(rawOff)) {
      markers.push({ index: match.index, end: markerRe.lastIndex, offset: Number(rawOff) });
    }
  }
  if (markers.length === 0) return html;

  let best = markers[0];
  let bestDist = Infinity;
  for (const m of markers) {
    // Prefer the last marker at or just before target, otherwise nearest overall
    const dist = m.offset <= target ? target - m.offset : (m.offset - target) * 2 + 10000;
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }

  return `${html.slice(0, best.index)}${TARGET_ANCHOR_SENTINEL}${html.slice(best.end)}`;
}

/**
 * Extracts a readable window centered near TARGET_ANCHOR_SENTINEL and prepends nearest page milestone.
 */
function extractWindowAroundAnchor(text, windowChars) {
  const anchorIdx = text.indexOf(TARGET_ANCHOR_SENTINEL);
  const cleanAll = text.replace(TARGET_ANCHOR_SENTINEL, '');
  if (cleanAll.length <= windowChars || anchorIdx === -1) {
    const truncated = windowChars > 0 && cleanAll.length > windowChars;
    return {
      text: truncated
        ? `${cleanAll.slice(0, windowChars)}\n\n[... Texto truncado a ${windowChars} caracteres de ${cleanAll.length} totales ...]`
        : cleanAll,
      truncated,
      totalChars: cleanAll.length,
    };
  }

  const beforeTarget = Math.floor(windowChars * 0.25);
  let start = Math.max(0, anchorIdx - beforeTarget);
  let end = Math.min(cleanAll.length, start + windowChars);
  if (end === cleanAll.length) {
    start = Math.max(0, end - windowChars);
  }

  if (start > 0) {
    const boundary = cleanAll.slice(start, Math.min(cleanAll.length, start + 120)).search(/\n\n|\s/);
    if (boundary > 0) start += boundary + 1;
  }
  if (end < cleanAll.length) {
    const tailSlice = cleanAll.slice(Math.max(0, end - 120), end);
    const lastBreak = Math.max(tailSlice.lastIndexOf('. '), tailSlice.lastIndexOf('\n'));
    if (lastBreak > 20) end = Math.max(0, end - 120) + lastBreak + 1;
  }

  let excerpt = cleanAll.slice(start, end).trim();
  // Prepend nearest earlier [Page N] milestone if missing from start of window
  if (start > 0 && !/^\[Page\s+\d+\]/i.test(excerpt)) {
    const priorPages = [...cleanAll.slice(0, start).matchAll(/\[Page\s+[^\]]+\]/gi)];
    if (priorPages.length > 0) {
      excerpt = `${priorPages[priorPages.length - 1][0]} ... ${excerpt}`;
    } else {
      excerpt = `... ${excerpt}`;
    }
  }
  if (end < cleanAll.length) {
    excerpt = `${excerpt} ...`;
  }

  return {
    text: excerpt,
    truncated: true,
    totalChars: cleanAll.length,
  };
}

/**
 * Converts Logos resource HTML (<div class="resourcetext">...</div>) into clean structured text/markdown.
 */
export function cleanArticleHtml(html, maxCharsOrOptions = 15000) {
  if (!html || typeof html !== 'string') {
    return { text: '', truncated: false, totalChars: 0 };
  }

  const opts =
    typeof maxCharsOrOptions === 'number'
      ? { maxChars: maxCharsOrOptions }
      : maxCharsOrOptions || {};
  const maxChars = opts.maxChars ?? 15000;
  const contextChars = opts.contextChars ?? 0;
  const linkBibleRefs = Boolean(opts.linkBibleRefs);

  let working = injectOffsetAnchor(html, opts.targetOffset)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<span[^>]*class=["'][^"']*offset-marker[^"']*["'][^>]*>\s*<\/span>/gi, '');

  // Preserve milestones (page numbers, Bible chapters/verses, headwords)
  working = working.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
    const rel = getAttr(attrs, 'rel');
    const dataType = getAttr(attrs, 'data-datatype');
    const dataRef = getAttr(attrs, 'data-reference');
    const className = getAttr(attrs, 'class') || '';
    const cleanInner = inner.replace(/<[^>]+>/g, '').trim();

    if (rel === 'milestone' && dataRef) {
      if (dataType === 'page' || /^Page\s/i.test(dataRef)) {
        return ` [${dataRef}] `;
      }
      if (!cleanInner) {
        return ` [${dataRef}] `;
      }
    }

    if (className.includes('bibleref') && dataRef && cleanInner) {
      return linkBibleRefs
        ? `[${cleanInner}](${buildBibleReferenceUrl(dataRef)})`
        : `${cleanInner} (${dataRef})`;
    }

    return inner;
  });

  working = working
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '\n\n## ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<(?:strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/(?:strong|b)>/gi, (_, inner) =>
      wrapInlineMarkdown(inner, '**')
    )
    .replace(/<(?:em|i)(?:\s[^>]*)?>([\s\S]*?)<\/(?:em|i)>/gi, (_, inner) =>
      wrapInlineMarkdown(inner, '*')
    )
    .replace(/<sup(?:\s[^>]*)?>([\s\S]*?)<\/sup>/gi, '^[$1]')
    .replace(/<[^>]+>/g, '');

  const normalized = decodeEntities(working)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (contextChars > 0) {
    return extractWindowAroundAnchor(normalized, contextChars);
  }

  const cleanNormalized = normalized.replace(TARGET_ANCHOR_SENTINEL, '');
  const totalChars = cleanNormalized.length;
  if (maxChars > 0 && totalChars > maxChars) {
    return {
      text: `${cleanNormalized.slice(0, maxChars)}\n\n[... Texto truncado a ${maxChars} caracteres de ${totalChars} totales ...]`,
      truncated: true,
      totalChars,
    };
  }

  return { text: cleanNormalized, truncated: false, totalChars };
}

/**
 * Builds a Logos ref.ly citation link (matching Study Assistant inline [1] links).
 */
export function buildReflyUrl({ resourceId, resourceVersion, offset }) {
  if (!resourceId) return LOGOS_ORIGIN;
  if (resourceVersion && offset !== undefined && offset !== null) {
    const pos = `res/${resourceId}/${resourceVersion}/${offset}`;
    return `https://ref.ly/logosres/${resourceId}?pos=${encodeURIComponent(pos)}`;
  }
  return buildLogosWebUrl({ resourceId, offset });
}

/**
 * Builds a Logos Web textrange URL highlighting the cited passage in app.logos.com.
 */
export function buildTextRangeUrl({ resourceId, resourceVersion, offset, length = 300 }) {
  if (!resourceId) return LOGOS_ORIGIN;
  if (resourceVersion && offset !== undefined && offset !== null) {
    const encId = encodeURIComponent(resourceId);
    const payload = JSON.stringify([
      {
        resourceId,
        resourceVersion,
        offset,
        length: Math.max(1, Number(length) || 300),
      },
    ]);
    return `${LOGOS_ORIGIN}/books/${encId}/offsets/${encodeURIComponent(String(offset))}/textranges/${encodeURIComponent(payload)}`;
  }
  return buildLogosWebUrl({ resourceId, offset });
}

/**
 * Builds a direct Bible or data-type reference URL in app.logos.com.
 */
export function buildBibleReferenceUrl(rawReference) {
  return `${LOGOS_ORIGIN}/references/${encodeURIComponent(String(rawReference))}`;
}

/**
 * Builds a direct deep-link URL to open a resource location in https://app.logos.com.
 */
export function buildLogosWebUrl({ resourceId, articleId, offset, reference, headword }) {
  if (!resourceId) return LOGOS_ORIGIN;
  const encId = encodeURIComponent(resourceId);

  if (offset !== undefined && offset !== null) {
    return `${LOGOS_ORIGIN}/books/${encId}/offsets/${encodeURIComponent(String(offset))}`;
  }
  if (articleId) {
    return `${LOGOS_ORIGIN}/books/${encId}/articles/${encodeURIComponent(articleId)}`;
  }
  if (reference) {
    return `${LOGOS_ORIGIN}/books/${encId}/references/${encodeURIComponent(reference)}`;
  }
  if (headword) {
    return `${LOGOS_ORIGIN}/books/${encId}/headwords/${encodeURIComponent(headword)}`;
  }
  return `${LOGOS_ORIGIN}/books/${encId}`;
}

/**
 * Performs an authenticated JSON request against https://app.logos.com.
 */
export async function logosRequest(apiPath, { method = 'GET', body } = {}) {
  const session = await loadSession();
  const url = apiPath.startsWith('http') ? apiPath : `${LOGOS_ORIGIN}${apiPath}`;

  const headers = {
    Cookie: session.cookieHeader,
    Accept: 'application/json',
    Origin: LOGOS_ORIGIN,
    Referer: `${LOGOS_ORIGIN}/`,
    'X-Requested-With': 'fetch',
    'User-Agent': session.userAgent,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Autenticación rechazada por app.logos.com (HTTP ${res.status}). Tu cookie de sesión expiró o no es válida. Ejecuta logos_sync_session para actualizar la sesión desde Chrome.`
    );
  }

  const rawText = await res.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const err = new Error(
      `Error HTTP ${res.status} en ${apiPath}: ${parsed?.message || rawText.slice(0, 300)}`
    );
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }

  return { data: parsed, session };
}

/**
 * Checks connectivity, user identity, citation settings, and library totals.
 */
export async function getStatus() {
  const [{ data: catalog, session }, prefResult] = await Promise.all([
    logosRequest('/api/app/library/facetedResults', {
      method: 'POST',
      body: {
        query: '',
        facetFilterQuery: '',
        offset: 0,
        limit: 5,
        sortField: 'title',
        selectedFacets: [],
        userLanguage: 'es-ES',
        getStoreResults: false,
        includeUnlicensed: false,
      },
    }),
    logosRequest('/api/app/user/getpreferences', {
      method: 'POST',
      body: {
        keys: [
          'LogosDesktop/CurrentCitationFormat',
          'LogosDesktop/PreferLemmaOverSurfaceText',
        ],
      },
    }).catch(() => ({ data: [] })),
  ]);

  const prefs = Object.fromEntries(
    (Array.isArray(prefResult?.data) ? prefResult.data : []).map((p) => [p.key, p.val])
  );

  return {
    authenticated: true,
    logosUserId: session.logosUserId,
    sessionSource: session.source,
    sessionUpdatedAt: session.updatedAt,
    totalLicensedBooks: catalog?.total ?? 0,
    citationFormat: prefs['LogosDesktop/CurrentCitationFormat'] ?? null,
    sampleBooks: (catalog?.items || []).map((b) => ({
      resourceId: b.resourceId,
      title: b.title,
      abbreviatedTitle: b.abbreviatedTitle || null,
      authors: b.authors || [],
      resourceType: b.resourceType,
      webUrl: buildLogosWebUrl({ resourceId: b.resourceId }),
    })),
  };
}

/**
 * Lists and filters licensed books in the user's Logos library, with optional details/TOC.
 */
export async function listBooks({
  query = '',
  language,
  resourceType,
  author,
  offset = 0,
  limit = 25,
  sortField = 'title',
  userLanguage = 'es-ES',
  includeDetailsForResourceId,
  parentTocId,
} = {}) {
  const filterTokens = [];
  if (query && query.trim()) filterTokens.push(query.trim());
  if (language && language.trim()) filterTokens.push(`lang:${language.trim()}`);
  if (resourceType && resourceType.trim()) filterTokens.push(`type:${resourceType.trim()}`);
  if (author && author.trim()) {
    const cleanAuthor = author.trim().replace(/"/g, '');
    filterTokens.push(cleanAuthor.includes(' ') ? `author:"${cleanAuthor}"` : `author:${cleanAuthor}`);
  }
  const effectiveQuery = filterTokens.join(' ');

  const { data } = await logosRequest('/api/app/library/facetedResults', {
    method: 'POST',
    body: {
      query: effectiveQuery,
      facetFilterQuery: '',
      offset: offset ?? 0,
      limit,
      sortField,
      selectedFacets: [],
      userLanguage,
      getStoreResults: false,
      includeUnlicensed: false,
    },
  });

  const items = (data?.items || []).map((item) => ({
    resourceId: item.resourceId,
    title: item.title,
    abbreviatedTitle: item.abbreviatedTitle || null,
    authors: item.authors || [],
    series: item.series || null,
    resourceType: item.resourceType,
    resourceTypeDisplayName: item.resourceTypeDisplayName,
    languages: item.languages || [],
    isSupported: Boolean(item.isSupported),
    webUrl: buildLogosWebUrl({ resourceId: item.resourceId }),
  }));

  let bookDetails = null;
  if (includeDetailsForResourceId) {
    const enc = encodeURIComponent(includeDetailsForResourceId);
    const tocUrl = parentTocId
      ? `/api/app/books/${enc}/tableofcontents?parentId=${encodeURIComponent(parentTocId)}`
      : `/api/app/books/${enc}/tableofcontents`;

    const [infoRes, tocRes] = await Promise.all([
      logosRequest(`/api/app/books/${enc}/infopagecontents`).catch((err) => ({
        data: { error: err.message },
      })),
      logosRequest(tocUrl).catch(() => ({ data: [] })),
    ]);

    bookDetails = {
      info: infoRes.data,
      tableOfContents: tocRes.data,
    };
  }

  const nextOffset =
    data?.total !== undefined && offset + items.length < data.total
      ? offset + items.length
      : null;

  return {
    effectiveQuery,
    total: data?.total ?? items.length,
    offset,
    count: items.length,
    nextOffset,
    items,
    facets: (data?.facets || []).slice(0, 6).map((f) => ({
      field: f.field,
      label: f.label,
      topTerms: (f.terms || []).slice(0, 10),
    })),
    bookDetails,
  };
}

/**
 * Searches licensed books (or Bibles) in the user's Logos library.
 * Defaults to mode="precise" (lexical) to avoid consuming Logos AI credits.
 */
export async function searchLibrary({
  query,
  mode = 'precise',
  scope = 'books',
  resourceIds = [],
  userLanguage = 'es-ES',
  caseSensitivity = 'ignoreCase',
  textMatch = 'stem',
  referenceExpansion = 'equivalent',
  order = 'relevance',
  includeUnlicensedResources = false,
  limit = 15,
  next,
} = {}) {
  if (!query || !query.trim()) {
    throw new Error('El parámetro "query" no puede estar vacío.');
  }

  const isBible = scope === 'bible';
  const endpoint = isBible ? '/api/app/search/v2/bible' : '/api/app/search/v2/books';

  let body;
  if (isBible) {
    body = {
      query,
      caseSensitivity,
      textMatch,
      referenceExpansion,
      resourceIds,
      limit,
    };
  } else if (mode === 'smart') {
    body = {
      query,
      semanticSearchSettings: { userLanguage },
      resourceIds,
      includeUnlicensedResources,
      limit,
    };
  } else {
    body = {
      query,
      articleSearchSettings: {
        caseSensitivity,
        textMatch,
        referenceExpansion,
        order,
      },
      resourceIds,
      includeUnlicensedResources,
      limit,
    };
  }

  if (next) {
    body.next = next;
  }

  const { data } = await logosRequest(endpoint, { method: 'POST', body });
  const rawResults = data?.results || [];

  // Bible search results omit resourceTitle; enrich via library/records when needed
  const missingTitleIds = [
    ...new Set(rawResults.filter((r) => !r.resourceTitle && r.resourceId).map((r) => r.resourceId)),
  ];
  const recordMap = new Map();
  if (missingTitleIds.length > 0) {
    const recordsRes = await logosRequest('/api/app/library/records', {
      method: 'POST',
      body: {
        resources: missingTitleIds.map((resourceId) => ({ resourceId })),
        fields: ['title', 'abbreviatedTitle', 'resourceType', 'resourceId'],
        includeUnlicensed: includeUnlicensedResources,
      },
    }).catch(() => null);

    const recList = recordsRes?.data?.resources || recordsRes?.data?.items || [];
    for (const rec of recList) {
      if (rec?.resourceId) recordMap.set(rec.resourceId, rec);
    }
  }

  const results = rawResults.map((r) => {
    const rec = recordMap.get(r.resourceId);
    const referenceRaw = r.reference?.raw || null;
    return {
      resourceId: r.resourceId,
      resourceVersion: r.resourceVersion || null,
      resourceTitle: r.resourceTitle || rec?.title || r.resourceId,
      resourceAbbreviatedTitle: r.resourceAbbreviatedTitle || rec?.abbreviatedTitle || null,
      resourceAuthors: r.resourceAuthors || [],
      articleId: r.article?.name || null,
      articleTitle: r.article?.text || null,
      displayReference: r.displayReference || r.reference?.text || null,
      referenceRaw,
      offset: r.offset ?? null,
      length: r.length ?? null,
      totalHits: r.totalHits ?? null,
      relevanceScore: r.resultRelevanceScore ?? null,
      isUnlicensed: Boolean(r.resourceIsUnlicensed),
      snippet: cleanRichTextXml(r.richTextXml),
      webUrl: buildLogosWebUrl({
        resourceId: r.resourceId,
        offset: r.offset,
        articleId: r.article?.name,
        reference: referenceRaw,
      }),
      reflyUrl: buildReflyUrl({
        resourceId: r.resourceId,
        resourceVersion: r.resourceVersion,
        offset: r.offset,
      }),
      textRangeUrl: buildTextRangeUrl({
        resourceId: r.resourceId,
        resourceVersion: r.resourceVersion,
        offset: r.offset,
        length: r.length || 300,
      }),
    };
  });

  return {
    query,
    scope,
    mode: isBible ? 'bible' : mode,
    aiCreditsConsumed: !isBible && mode === 'smart',
    count: results.length,
    next: data?.next || null,
    results,
  };
}

/**
 * Reads full article, reference, headword, or offset text from a licensed resource,
 * plus previous/next article navigation and optional TOC/bibliographic info.
 */
export async function readResource({
  resourceId,
  articleId,
  offset,
  reference,
  headword,
  includeToc = false,
  parentTocId,
  maxChars = 15000,
  contextChars = 0,
  linkBibleRefs = false,
} = {}) {
  if (!resourceId || !resourceId.trim()) {
    throw new Error('El parámetro "resourceId" es obligatorio (ejemplo: "LLS:STBERKHOF").');
  }

  const encId = encodeURIComponent(resourceId);
  let targetUrl;
  if (articleId) {
    targetUrl = `/api/app/books/${encId}/articles/${encodeURIComponent(articleId)}?preview=false`;
  } else if (offset !== undefined && offset !== null) {
    targetUrl = `/api/app/books/${encId}/offsets/${encodeURIComponent(String(offset))}?preview=false`;
  } else if (reference) {
    targetUrl = `/api/app/books/${encId}/references/${encodeURIComponent(reference)}?preview=false`;
  } else if (headword) {
    targetUrl = `/api/app/books/${encId}/headwords/${encodeURIComponent(headword)}?preview=false`;
  } else {
    targetUrl = `/api/app/books/${encId}`;
  }

  let articleData = null;
  let previewFallbackText = null;
  let resolvedResourceId = resourceId;

  try {
    const res = await logosRequest(targetUrl);
    articleData = res.data;
  } catch (err) {
    // Fallback to /api/app/preview if reference/headword lookup fails with 404
    if ((reference || headword) && (err.status === 404 || err.status === 400)) {
      const qs = new URLSearchParams({ resourceId, preferKeyLinkForBibleReference: 'true' });
      if (reference) qs.set('reference', reference);
      if (headword) qs.set('headword', headword);
      const previewRes = await logosRequest(`/api/app/preview?${qs.toString()}`);
      if (previewRes.data?.richText) {
        previewFallbackText = cleanRichTextXml(previewRes.data.richText, { highlightHits: false });
        resolvedResourceId = previewRes.data.resolvedResourceId || resourceId;
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  // Some article endpoints return 200 with missing content when preview endpoint is required
  if (!previewFallbackText && !articleData?.article?.content && (reference || headword)) {
    const qs = new URLSearchParams({ resourceId, preferKeyLinkForBibleReference: 'true' });
    if (reference) qs.set('reference', reference);
    if (headword) qs.set('headword', headword);
    const previewRes = await logosRequest(`/api/app/preview?${qs.toString()}`).catch(() => null);
    if (previewRes?.data?.richText) {
      previewFallbackText = cleanRichTextXml(previewRes.data.richText, { highlightHits: false });
      resolvedResourceId = previewRes.data.resolvedResourceId || resourceId;
    }
  }

  let info = null;
  let tableOfContents = null;
  if (includeToc) {
    const tocUrl = parentTocId
      ? `/api/app/books/${encId}/tableofcontents?parentId=${encodeURIComponent(parentTocId)}`
      : `/api/app/books/${encId}/tableofcontents`;

    const [infoRes, tocRes] = await Promise.all([
      logosRequest(`/api/app/books/${encId}/infopagecontents`).catch(() => ({ data: null })),
      logosRequest(tocUrl).catch(() => ({ data: null })),
    ]);
    info = infoRes.data;
    tableOfContents = tocRes.data;
  }

  if (previewFallbackText !== null) {
    const truncated = maxChars > 0 && previewFallbackText.length > maxChars;
    return {
      resourceId: resolvedResourceId,
      resourceTitle: info?.title || resolvedResourceId,
      abbreviatedTitle: info?.abbreviatedTitle || null,
      resourceVersion: null,
      articleId: null,
      indexedOffset: null,
      indexedLength: null,
      matchedReference: reference || headword || null,
      previousArticleId: null,
      nextArticleId: null,
      webUrl: buildLogosWebUrl({ resourceId: resolvedResourceId, reference, headword }),
      reflyUrl: null,
      truncated,
      totalChars: previewFallbackText.length,
      text: truncated ? previewFallbackText.slice(0, maxChars) : previewFallbackText,
      info,
      tableOfContents,
    };
  }

  const parsedHtml = cleanArticleHtml(articleData?.article?.content || '', {
    maxChars,
    targetOffset: offset,
    contextChars,
    linkBibleRefs,
  });
  const resolvedArticleId = articleData?.article?.articleId || articleId || null;
  const resolvedOffset = offset ?? articleData?.article?.indexedOffset ?? null;
  const finalResourceId = articleData?.resourceId || resourceId;
  const finalVersion = articleData?.resourceVersion || null;

  return {
    resourceId: finalResourceId,
    resourceTitle: articleData?.resourceTitle || info?.title || resourceId,
    abbreviatedTitle: articleData?.abbreviatedTitle || info?.abbreviatedTitle || null,
    resourceVersion: finalVersion,
    articleId: resolvedArticleId,
    indexedOffset: resolvedOffset,
    indexedLength: articleData?.article?.indexedLength ?? null,
    matchedReference: articleData?.matchedReference || reference || headword || null,
    previousArticleId: articleData?.previousArticleId || null,
    nextArticleId: articleData?.nextArticleId || null,
    webUrl: buildLogosWebUrl({
      resourceId: finalResourceId,
      offset: resolvedOffset,
      articleId: resolvedArticleId,
      reference,
      headword,
    }),
    reflyUrl: buildReflyUrl({
      resourceId: finalResourceId,
      resourceVersion: finalVersion,
      offset: resolvedOffset,
    }),
    truncated: parsedHtml.truncated,
    totalChars: parsedHtml.totalChars,
    text: parsedHtml.text,
    info,
    tableOfContents,
  };
}

/**
 * Formats rendered Logos citation HTML/plainText into Logos Study Assistant Markdown style
 * with hyperlinked chapter/book title and trailing page/volume locator.
 */
function parseCitationParts({ html, plainText, textRangeUrl }) {
  const cleanPlain = (plainText || '').trim();
  if (!cleanPlain) {
    return { baseBody: '', locator: null, locatorUrl: textRangeUrl, markdownFootnote: '' };
  }

  let bodyWithoutLocator = cleanPlain.replace(/\.$/, '');
  let locator = null;
  let locatorSeparator = ', ';
  const commaLocMatch = cleanPlain.match(/,\s*([^,()]+?)\.?$/);
  const parenLocMatch = cleanPlain.match(/\)\s+(\d+(?::\d+)?(?:[–-]\d+(?::\d+)?)?)\.?$/);

  if (commaLocMatch && /\d/.test(commaLocMatch[1]) && !commaLocMatch[1].trim().endsWith(')')) {
    locator = commaLocMatch[1].trim();
    bodyWithoutLocator = cleanPlain.slice(0, commaLocMatch.index).trim();
    locatorSeparator = ', ';
  } else if (parenLocMatch) {
    locator = parenLocMatch[1].trim();
    bodyWithoutLocator = cleanPlain.slice(0, parenLocMatch.index + 1).trim();
    locatorSeparator = ' ';
  }

  const escapeLabel = (s) => s.replace(/[[\]]/g, '\\$&');
  let linkedBody = bodyWithoutLocator;

  // Prefer linking a quoted article/chapter title when present, else link the first italicized book title
  const quotedMatch = bodyWithoutLocator.match(/“([^”]+)”/);
  if (quotedMatch) {
    linkedBody = bodyWithoutLocator.replace(
      quotedMatch[0],
      () => `“[${escapeLabel(quotedMatch[1])}](${textRangeUrl})”`
    );
  } else if (html) {
    const italicMatch = html.match(/<span[^>]*font-style:\s*italic[^>]*>([\s\S]*?)<\/span>/i);
    const bookTitle = italicMatch
      ? decodeEntities(italicMatch[1].replace(/<[^>]+>/g, '')).trim()
      : null;
    if (bookTitle && bodyWithoutLocator.includes(bookTitle)) {
      linkedBody = bodyWithoutLocator.replace(
        bookTitle,
        () => `[${escapeLabel(bookTitle)}](${textRangeUrl})`
      );
    }
  }

  const markdownFootnote = locator
    ? `${linkedBody}${locatorSeparator}[${locator}](${textRangeUrl}).`
    : `${linkedBody}.`;

  return {
    baseBody: linkedBody,
    locatorSeparator,
    locator,
    locatorUrl: textRangeUrl,
    markdownFootnote,
  };
}

/**
 * Fetches the user's preferred Logos citation format (default "sbl-v2").
 */
async function resolveCitationFormat(formatName) {
  if (formatName) return formatName;
  try {
    const pref = await logosRequest('/api/app/user/getpreferences', {
      method: 'POST',
      body: { keys: ['LogosDesktop/CurrentCitationFormat'] },
    });
    const entry = Array.isArray(pref.data) ? pref.data[0] : null;
    return entry?.val || 'sbl-v2';
  } catch {
    return 'sbl-v2';
  }
}

/**
 * Renders official academic citations via /api/app/resources/citation/render for one or more text ranges.
 */
export async function renderCitationsBatch({ items = [], formatName } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Debes indicar al menos un elemento en "items" con resourceId y offset.');
  }
  const resolvedFormat = await resolveCitationFormat(formatName);

  const rendered = await Promise.all(
    items.map(async (item) => {
      const resourceId = item.resourceId;
      let resourceVersion = item.resourceVersion;
      const offset = item.offset;
      const length = Math.min(Math.max(1, Number(item.length) || 300), 1800);

      if (!resourceVersion && offset !== undefined && offset !== null) {
        const meta = await logosRequest(
          `/api/app/books/${encodeURIComponent(resourceId)}/offsets/${encodeURIComponent(String(offset))}?preview=false`
        ).catch(() => null);
        resourceVersion = meta?.data?.resourceVersion || null;
      }

      const reflyUrl = buildReflyUrl({ resourceId, resourceVersion, offset });
      const textRangeUrl = buildTextRangeUrl({ resourceId, resourceVersion, offset, length });

      if (!resourceVersion || offset === undefined || offset === null) {
        return {
          resourceId,
          resourceVersion,
          offset: offset ?? null,
          length,
          formatName: resolvedFormat,
          plainText: `${resourceId}`,
          html: null,
          reflyUrl,
          textRangeUrl,
          markdownFootnote: `[${resourceId}](${textRangeUrl}).`,
        };
      }

      const textRange = {
        resource: { id: resourceId, version: resourceVersion },
        indexedOffset: offset,
        indexedLength: length,
      };
      const { data } = await logosRequest('/api/app/resources/citation/render', {
        method: 'POST',
        body: {
          citation: { textRange, resource: null },
          formatName: resolvedFormat,
        },
      });

      const parts = parseCitationParts({
        html: data?.html || '',
        plainText: data?.plainText || '',
        textRangeUrl,
      });

      return {
        resourceId,
        resourceVersion,
        offset,
        length,
        formatName: resolvedFormat,
        plainText: data?.plainText || '',
        html: data?.html || '',
        reflyUrl,
        textRangeUrl,
        ...parts,
      };
    })
  );

  return { formatName: resolvedFormat, count: rendered.length, citations: rendered };
}

/**
 * Scores a candidate search hit by query coverage, rank, and resourceType preference.
 */
function scoreCandidate(candidate, preferredResourceTypes = []) {
  let score = candidate.baseScore;
  // Boost hits corroborated by multiple search angles
  score += (candidate.matchedQueries.size - 1) * 0.45;
  if (candidate.resourceType && preferredResourceTypes.length > 0) {
    const rt = candidate.resourceType.toLowerCase();
    if (preferredResourceTypes.some((p) => rt.includes(p.toLowerCase()))) {
      score += 0.6;
    }
  }
  return score;
}

/**
 * Executes the 4-step Logos theological research workflow:
 * 1) Multi-angle search, 2) Resource evaluation & diversification,
 * 3) Context extraction + official Logos citation rendering,
 * 4) Packaged evidence + ready-to-use inline/footnote Markdown references.
 */
export async function researchTopic({
  question,
  queries = [],
  preferredResourceTypes = [],
  resourceIds = [],
  mode = 'precise',
  scope = 'books',
  userLanguage = 'es-ES',
  maxSources = 8,
  contextCharsPerSource = 1600,
  citationFormat,
} = {}) {
  const effectiveQueries = (queries.length > 0 ? queries : [question])
    .map((q) => (q || '').trim())
    .filter(Boolean)
    .slice(0, 6);

  if (effectiveQueries.length === 0) {
    throw new Error('Debes proporcionar "question" o al menos una consulta en "queries".');
  }

  const perQueryLimit = Math.min(25, Math.max(10, maxSources * 2));
  const [resolvedFormat, ...searchRuns] = await Promise.all([
    resolveCitationFormat(citationFormat),
    ...effectiveQueries.map((q) =>
      searchLibrary({
        query: q,
        mode,
        scope,
        resourceIds,
        userLanguage,
        includeUnlicensedResources: false,
        limit: perQueryLimit,
      }).then((res) => ({ query: q, res }))
    ),
  ]);

  // Deduplicate passages by resourceId + offset while tracking cross-query matches
  const candidateMap = new Map();
  for (const run of searchRuns) {
    run.res.results.forEach((hit, idx) => {
      const key = `${hit.resourceId}::${hit.offset ?? hit.articleId ?? idx}`;
      const rankScore = 1 / (idx + 1);
      if (!candidateMap.has(key)) {
        candidateMap.set(key, {
          ...hit,
          matchedQueries: new Set([run.query]),
          baseScore: rankScore,
        });
      } else {
        const prev = candidateMap.get(key);
        prev.matchedQueries.add(run.query);
        prev.baseScore = Math.max(prev.baseScore, rankScore);
      }
    });
  }

  // Enrich candidates with resourceType when preference filtering is active
  const candidates = Array.from(candidateMap.values());
  if (candidates.length > 0) {
    const uniqueIds = [...new Set(candidates.map((c) => c.resourceId))];
    const recRes = await logosRequest('/api/app/library/records', {
      method: 'POST',
      body: {
        resources: uniqueIds.map((id) => ({ resourceId: id })),
        fields: ['resourceId', 'resourceType', 'title', 'abbreviatedTitle'],
        includeUnlicensed: false,
      },
    }).catch(() => null);

    const typeById = new Map();
    for (const rec of recRes?.data?.resources || recRes?.data?.items || []) {
      if (rec?.resourceId) typeById.set(rec.resourceId, rec.resourceType || null);
    }
    for (const c of candidates) {
      c.resourceType = typeById.get(c.resourceId) || null;
      c.evalScore = scoreCandidate(c, preferredResourceTypes);
    }
  }

  candidates.sort((a, b) => (b.evalScore || 0) - (a.evalScore || 0));

  // Select diverse passages (at most 2 passages per book initially; backfill if needed)
  const selected = [];
  const perBookCount = new Map();
  const maxPerBook = maxSources >= 6 ? 2 : 1;

  for (const c of candidates) {
    if (selected.length >= maxSources) break;
    const count = perBookCount.get(c.resourceId) || 0;
    if (count < maxPerBook) {
      selected.push(c);
      perBookCount.set(c.resourceId, count + 1);
    }
  }
  if (selected.length < maxSources) {
    const picked = new Set(selected);
    for (const c of candidates) {
      if (selected.length >= maxSources) break;
      if (!picked.has(c)) selected.push(c);
    }
  }

  // Collect expanded context + official Logos citations in parallel for all selected passages
  const [contexts, citationsBatch] = await Promise.all([
    Promise.all(
      selected.map((hit) =>
        readResource({
          resourceId: hit.resourceId,
          offset: hit.offset ?? undefined,
          articleId: hit.offset === null || hit.offset === undefined ? hit.articleId : undefined,
          contextChars: contextCharsPerSource,
          maxChars: Math.max(contextCharsPerSource * 2, 4000),
          linkBibleRefs: true,
        }).catch(() => null)
      )
    ),
    selected.length > 0
      ? renderCitationsBatch({
          items: selected.map((hit) => ({
            resourceId: hit.resourceId,
            resourceVersion: hit.resourceVersion,
            offset: hit.offset,
            length: hit.length || 300,
          })),
          formatName: resolvedFormat,
        }).catch(() => ({ citations: [] }))
      : Promise.resolve({ citations: [] }),
  ]);

  // Assign footnote numbers grouped by distinct resource (like Logos [6] citing pp. 299, 302, 442)
  const footnoteByResource = new Map();
  const bibliographyGroups = [];

  const sources = selected.map((hit, i) => {
    const cit = citationsBatch.citations?.[i];
    const ctx = contexts[i];
    let footnoteNumber = footnoteByResource.get(hit.resourceId);

    if (!footnoteNumber) {
      footnoteNumber = bibliographyGroups.length + 1;
      footnoteByResource.set(hit.resourceId, footnoteNumber);
      bibliographyGroups.push({
        footnoteNumber,
        resourceId: hit.resourceId,
        baseBody: cit?.baseBody || `${hit.resourceTitle}`,
        locatorSeparator: cit?.locatorSeparator || ', ',
        locators: [],
      });
    }

    const group = bibliographyGroups[footnoteNumber - 1];
    const locLabel = cit?.locator || hit.displayReference || `off.${hit.offset ?? 0}`;
    const locUrl = cit?.locatorUrl || hit.textRangeUrl;
    if (!group.locators.some((l) => l.label === locLabel && l.url === locUrl)) {
      group.locators.push({ label: locLabel, url: locUrl });
    }

    const reflyUrl = cit?.reflyUrl || hit.reflyUrl;
    return {
      footnoteNumber,
      inlineCitationMarkdown: `[\\[${footnoteNumber}\\]](${reflyUrl})`,
      resourceId: hit.resourceId,
      resourceTitle: hit.resourceTitle,
      resourceType: hit.resourceType || null,
      resourceAuthors: hit.resourceAuthors || [],
      articleId: hit.articleId,
      articleTitle: hit.articleTitle,
      displayReference: hit.displayReference,
      matchedQueries: Array.from(hit.matchedQueries),
      snippet: hit.snippet,
      expandedContext: ctx?.text || hit.snippet,
      plainCitation: cit?.plainText || hit.resourceTitle,
      reflyUrl,
      textRangeUrl: locUrl,
      previousArticleId: ctx?.previousArticleId || null,
      nextArticleId: ctx?.nextArticleId || null,
    };
  });

  const bibliographyEntries = bibliographyGroups.map((g) => {
    const locLinks = g.locators.map((l) => `[${l.label}](${l.url})`).join(', ');
    return `[${g.footnoteNumber}] ${g.baseBody}${locLinks ? `${g.locatorSeparator}${locLinks}` : ''}.`;
  });

  return {
    question: question || effectiveQueries[0],
    queriesExecuted: effectiveQueries,
    mode: scope === 'bible' ? 'bible' : mode,
    aiCreditsConsumed: scope !== 'bible' && mode === 'smart',
    citationFormat: resolvedFormat,
    evaluatedResourceCount: new Set(candidates.map((c) => c.resourceId)).size,
    selectedPassageCount: sources.length,
    sources,
    bibliographyMarkdown: bibliographyEntries.join('\n'),
    formattingInstructions:
      'Redacta la respuesta en español combinando síntesis analítica y evidencia citada con ejemplos concretos. ' +
      'Usa exactamente "inlineCitationMarkdown" (ej. [\\[1\\]](https://ref.ly/...)) al final de las afirmaciones respaldadas por cada fuente, ' +
      'conserva los enlaces bíblicos Markdown de "expandedContext" (ej. [Mateo 18](https://app.logos.com/references/bible.61.18)), ' +
      'y añade al final la bibliografía numerada usando exactamente "bibliographyMarkdown".',
  };
}
