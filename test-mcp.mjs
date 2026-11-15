import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname);

function parseToolJson(result, label) {
  assert.ok(!result.isError, `${label} devolvió error: ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.content) && result.content.length > 0, `${label} sin contenido`);
  const textItem = result.content.find((c) => c.type === 'text');
  assert.ok(textItem?.text, `${label} sin bloque de texto`);
  return JSON.parse(textItem.text);
}

async function main() {
  // 1. Ensure no legacy session file with credentials exists inside the project folder
  await assert.rejects(
    fs.access(path.join(PROJECT_ROOT, '.logos-session.json')),
    { code: 'ENOENT' },
    'No debe existir .logos-session.json dentro de la carpeta del proyecto'
  );
  console.log('[PASS] Sin archivo de credenciales dentro del proyecto');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'src', 'index.mjs')],
    cwd: PROJECT_ROOT,
  });

  const client = new Client({ name: 'logos-web-mcp-test-client', version: '1.0.0' });
  await client.connect(transport);

  try {
    // 2. Verify registered tools and prompts
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'logos_list_books',
      'logos_read_resource',
      'logos_render_citations',
      'logos_research_topic',
      'logos_search_library',
      'logos_status',
      'logos_sync_session',
    ]);
    console.log('[PASS] listTools:', names.join(', '));

    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === 'logos_investigar'));
    console.log('[PASS] listPrompts:', prompts.map((p) => p.name).join(', '));

    // 3. Verify logos_status (account-agnostic)
    const status = parseToolJson(
      await client.callTool({ name: 'logos_status', arguments: {} }),
      'logos_status'
    );
    assert.equal(status.authenticated, true);
    assert.ok(status.totalLicensedBooks > 0, 'La cuenta debe tener libros licenciados');
    assert.ok(Array.isArray(status.sampleBooks) && status.sampleBooks.length > 0);
    console.log(
      `[PASS] logos_status: authenticated=true, books=${status.totalLicensedBooks}, citation=${status.citationFormat}`
    );

    // 4. Verify logos_list_books using the first sample book returned by the user's account
    const sampleId = status.sampleBooks[0].resourceId;
    const catalog = parseToolJson(
      await client.callTool({
        name: 'logos_list_books',
        arguments: {
          limit: 5,
          includeDetailsForResourceId: sampleId,
        },
      }),
      'logos_list_books'
    );
    assert.ok(catalog.total > 0 && catalog.items.length > 0);
    assert.ok(catalog.bookDetails?.info);
    console.log(
      `[PASS] logos_list_books: total=${catalog.total}, sample="${sampleId}", title="${catalog.bookDetails.info.title || sampleId}"`
    );

    // 5. Verify logos_search_library (precise mode = zero AI credits)
    const search = parseToolJson(
      await client.callTool({
        name: 'logos_search_library',
        arguments: {
          query: 'God OR Dios',
          mode: 'precise',
          limit: 5,
        },
      }),
      'logos_search_library'
    );
    assert.equal(search.mode, 'precise');
    assert.equal(search.aiCreditsConsumed, false);
    assert.ok(search.results.length > 0, 'La búsqueda debe devolver al menos 1 resultado');
    const firstHit = search.results[0];
    assert.ok(firstHit.resourceId);
    assert.ok(firstHit.snippet && firstHit.snippet.length > 10);
    assert.ok(typeof firstHit.offset === 'number');
    assert.ok(firstHit.webUrl.startsWith('https://app.logos.com/books/'));
    console.log(
      `[PASS] logos_search_library: count=${search.results.length}, top="${firstHit.resourceTitle}" (${firstHit.displayReference || firstHit.articleId || firstHit.offset})`
    );

    // 6. Verify logos_read_resource on the top search hit
    const readArgs = firstHit.articleId
      ? { resourceId: firstHit.resourceId, articleId: firstHit.articleId }
      : { resourceId: firstHit.resourceId, offset: firstHit.offset };

    const article = parseToolJson(
      await client.callTool({
        name: 'logos_read_resource',
        arguments: readArgs,
      }),
      'logos_read_resource'
    );
    assert.ok(article.text.length > 100, 'El contenido leído debe tener más de 100 caracteres');
    console.log(
      `[PASS] logos_read_resource: resource=${article.resourceId}, chars=${article.totalChars}, article=${article.articleId}`
    );

    // 7. Verify logos_render_citations
    const citRes = parseToolJson(
      await client.callTool({
        name: 'logos_render_citations',
        arguments: {
          items: [
            {
              resourceId: firstHit.resourceId,
              resourceVersion: firstHit.resourceVersion,
              offset: firstHit.offset,
              length: firstHit.length || 300,
            },
          ],
        },
      }),
      'logos_render_citations'
    );
    assert.equal(citRes.citations.length, 1);
    assert.ok(citRes.citations[0].plainText.length > 5);
    assert.ok(citRes.citations[0].reflyUrl.startsWith('https://ref.ly/logosres/'));
    assert.ok(citRes.citations[0].textRangeUrl.includes('/textranges/'));
    assert.ok(citRes.citations[0].markdownFootnote.includes('textranges'));
    console.log('[PASS] logos_render_citations:', citRes.citations[0].plainText);

    // 8. Verify 4-step logos_research_topic workflow
    const research = parseToolJson(
      await client.callTool({
        name: 'logos_research_topic',
        arguments: {
          question: '¿Qué errores se cometen al interpretar y predicar las parábolas?',
          queries: ['parables allegory moralizing', 'errores predicar parabolas'],
          preferredResourceTypes: ['dictionary', 'encyclopedia', 'monograph'],
          maxSources: 4,
          contextCharsPerSource: 1000,
        },
      }),
      'logos_research_topic'
    );
    assert.equal(research.aiCreditsConsumed, false);
    assert.ok(research.sources.length >= 2, 'Debe devolver múltiples fuentes evaluadas');
    assert.ok(research.sources[0].expandedContext.length > 150);
    assert.match(research.sources[0].inlineCitationMarkdown, /\[\\\[\d+\\\]\]\(https:\/\/ref\.ly\/logosres\//);
    assert.match(research.bibliographyMarkdown, /^\[1\]\s+/);
    console.log(
      `[PASS] logos_research_topic: evaluatedBooks=${research.evaluatedResourceCount}, selected=${research.selectedPassageCount}, format=${research.citationFormat}`
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
