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
 * Converts Logos resource HTML (<div class="resourcetext">...</div>) into clean structured text/markdown.
 */
export function cleanArticleHtml(html, maxChars = 15000) {
  if (!html || typeof html !== 'string') {
    return { text: '', truncated: false, totalChars: 0 };
  }

  let working = html
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
      return `${cleanInner} (${dataRef})`;
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

  const totalChars = normalized.length;
  if (maxChars > 0 && totalChars > maxChars) {
    return {
      text: `${normalized.slice(0, maxChars)}\n\n[... Texto truncado a ${maxChars} caracteres de ${totalChars} totales ...]`,
      truncated: true,
      totalChars,
    };
  }

  return { text: normalized, truncated: false, totalChars };
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
      truncated,
      totalChars: previewFallbackText.length,
      text: truncated ? previewFallbackText.slice(0, maxChars) : previewFallbackText,
      info,
      tableOfContents,
    };
  }

  const parsedHtml = cleanArticleHtml(articleData?.article?.content || '', maxChars);
  const resolvedArticleId = articleData?.article?.articleId || articleId || null;
  const resolvedOffset = articleData?.article?.indexedOffset ?? offset ?? null;

  return {
    resourceId: articleData?.resourceId || resourceId,
    resourceTitle: articleData?.resourceTitle || info?.title || resourceId,
    abbreviatedTitle: articleData?.abbreviatedTitle || info?.abbreviatedTitle || null,
    resourceVersion: articleData?.resourceVersion || null,
    articleId: resolvedArticleId,
    indexedOffset: resolvedOffset,
    indexedLength: articleData?.article?.indexedLength ?? null,
    matchedReference: articleData?.matchedReference || reference || headword || null,
    previousArticleId: articleData?.previousArticleId || null,
    nextArticleId: articleData?.nextArticleId || null,
    webUrl: buildLogosWebUrl({
      resourceId: articleData?.resourceId || resourceId,
      offset: resolvedOffset,
      articleId: resolvedArticleId,
      reference,
      headword,
    }),
    truncated: parsedHtml.truncated,
    totalChars: parsedHtml.totalChars,
    text: parsedHtml.text,
    info,
    tableOfContents,
  };
}
