#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { syncSessionFromChrome } from './cdp-sync.mjs';
import { getStatus, listBooks, readResource, searchLibrary } from './logos-client.mjs';
import { saveSession } from './session.mjs';

const server = new McpServer({
  name: 'logos-web-mcp',
  version: '1.0.0',
});

/**
 * Formats successful JSON responses and surfaces tool errors cleanly for MCP clients.
 */
function runTool(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: err?.message || String(err),
          },
        ],
      };
    }
  };
}

server.registerTool(
  'logos_status',
  {
    title: 'Estado de sesión en Logos Web',
    description:
      'Verifica la conexión y sesión autenticada en https://app.logos.com, devolviendo el ID de usuario, total de libros licenciados en la biblioteca, formato de cita y una muestra de libros.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  runTool(async () => getStatus())
);

server.registerTool(
  'logos_search_library',
  {
    title: 'Buscar en la biblioteca de Logos',
    description:
      'Busca contenido dentro de los libros licenciados en tu cuenta de Logos (teología, comentarios, diccionarios, historia, biblias) y devuelve fragmentos con término resaltado, referencia exacta, articleId, offset y enlaces directos a app.logos.com. NOTA IMPORTANTE: mode="precise" (predeterminado) usa búsqueda léxica/morfológica y NO consume créditos de IA de Logos; mode="smart" usa búsqueda semántica y SÍ consume créditos de IA.',
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe('Término o consulta de búsqueda (soporta operadores de Logos como AND, OR, NEAR).'),
      mode: z
        .enum(['precise', 'smart'])
        .default('precise')
        .describe(
          'precise (predeterminado, no gasta créditos de IA) vs smart (búsqueda semántica, gasta créditos de IA; úsalo solo si se solicita explícitamente).'
        ),
      scope: z
        .enum(['books', 'bible'])
        .default('books')
        .describe('books para buscar en libros/comentarios/diccionarios; bible para búsqueda bíblica por versículos.'),
      resourceIds: z
        .array(z.string())
        .default([])
        .describe('Lista opcional de resourceId específicos para acotar la búsqueda (ej. ["LLS:STBERKHOF"]). Vacío busca en toda la biblioteca.'),
      userLanguage: z.string().default('es-ES').describe('Código de idioma para resultados/semántica (ej. "es-ES", "en-US").'),
      caseSensitivity: z.enum(['ignoreCase', 'matchCase']).default('ignoreCase'),
      textMatch: z
        .enum(['stem', 'exact'])
        .default('stem')
        .describe('stem (coincidir con formas flexivas/raíces) o exact (forma exacta).'),
      referenceExpansion: z.enum(['equivalent', 'none']).default('equivalent'),
      order: z.string().default('relevance').describe('Orden de resultados (ej. "relevance").'),
      includeUnlicensedResources: z
        .boolean()
        .default(false)
        .describe('Si false (predeterminado), busca solo en recursos licenciados de la cuenta.'),
      limit: z.number().int().min(1).max(50).default(15).describe('Número máximo de resultados por página (1-50).'),
      next: z.string().optional().describe('Cursor "next" devuelto por una búsqueda previa para paginar.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  runTool(async (args) => searchLibrary(args))
);

server.registerTool(
  'logos_list_books',
  {
    title: 'Listar y filtrar catálogo de libros en Logos',
    description:
      'Explora y filtra los libros disponibles en la biblioteca licenciada de Logos por texto, idioma, tipo de recurso o autor, y opcionalmente obtiene ficha bibliográfica e índice (tabla de contenidos) de un libro específico.',
    inputSchema: {
      query: z
        .string()
        .default('')
        .describe('Consulta de biblioteca (soporta sintaxis de Logos: lang:es, type:bible, type:commentary, author:Berkhof, series:..., title:...).'),
      language: z.string().optional().describe('Filtro rápido por código de idioma ISO (ej. "es", "en", "el", "he").'),
      resourceType: z
        .string()
        .optional()
        .describe('Filtro rápido por tipo Logos (ej. "bible", "commentary", "text.monograph.systematic-theology", "encyclopedia").'),
      author: z.string().optional().describe('Filtro rápido por nombre o apellido de autor.'),
      offset: z.number().int().min(0).default(0).describe('Desplazamiento inicial para paginar resultados.'),
      limit: z.number().int().min(1).max(50).default(25).describe('Cantidad de libros a devolver (1-50).'),
      sortField: z.string().default('title').describe('Campo de ordenación (ej. "title").'),
      userLanguage: z.string().default('es-ES').describe('Idioma para etiquetas de facetas (ej. "es-ES").'),
      includeDetailsForResourceId: z
        .string()
        .optional()
        .describe('Si se indica un resourceId, incluye también infopagecontents y tableofcontents de ese recurso.'),
      parentTocId: z
        .string()
        .optional()
        .describe('ID padre del índice para expandir subcapítulos cuando se usa includeDetailsForResourceId.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  runTool(async (args) => listBooks(args))
);

server.registerTool(
  'logos_read_resource',
  {
    title: 'Leer artículo, capítulo o referencia en Logos',
    description:
      'Recupera el texto completo y limpio de una sección, artículo, página, pasaje bíblico, entrada de diccionario (headword) u offset dentro de cualquier libro licenciado en Logos. Incluye marcadores de página ([Page N]), referencias bíblicas, previousArticleId/nextArticleId para lectura continua, y tabla de contenidos opcional (includeToc: true).',
    inputSchema: {
      resourceId: z
        .string()
        .min(1)
        .describe('Identificador del libro en Logos (ej. "LLS:STBERKHOF", "LLS:NBLH").'),
      articleId: z
        .string()
        .optional()
        .describe('ID del artículo/sección (obtenido en logos_search_library o previousArticleId/nextArticleId).'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Offset exacto dentro del recurso (obtenido en logos_search_library o tableofcontents).'),
      reference: z
        .string()
        .optional()
        .describe('Referencia del recurso o bíblica (ej. "page.520", "bible.66.3.25").'),
      headword: z
        .string()
        .optional()
        .describe('Entrada o lema para diccionarios/enciclopedias/léxicos (ej. "Justification").'),
      includeToc: z
        .boolean()
        .default(false)
        .describe('Si true, incluye metadatos bibliográficos y tabla de contenidos del recurso.'),
      parentTocId: z
        .string()
        .optional()
        .describe('ID de nodo en tableofcontents para cargar subsecciones hijas cuando includeToc=true.'),
      maxChars: z
        .number()
        .int()
        .min(500)
        .max(60000)
        .default(15000)
        .describe('Límite máximo de caracteres devueltos del cuerpo de lectura.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  runTool(async (args) => readResource(args))
);

server.registerTool(
  'logos_sync_session',
  {
    title: 'Sincronizar sesión autenticada de Logos',
    description:
      'Actualiza las cookies de sesión (~/.logos-web-mcp/session.json) ya sea pasando manualmente cookieHeader (cabecera Cookie o comando curl desde DevTools) o leyendo automáticamente las cookies desde el navegador Chrome/Edge/Brave abierto con depuración remota (chrome://inspect/#remote-debugging).',
    inputSchema: {
      cookieHeader: z
        .string()
        .optional()
        .describe(
          'Opcional: cabecera Cookie completa (o comando curl copiado de DevTools en app.logos.com). Si se omite, intenta sincronizar desde Chrome vía CDP.'
        ),
      logosUserId: z.string().optional().describe('Opcional: ID numérico de usuario de Logos si no viene embebido en cookies.'),
      userDataDir: z
        .string()
        .optional()
        .describe('Opcional: carpeta User Data de Chrome donde buscar DevToolsActivePort.'),
      wsEndpoint: z.string().optional().describe('Opcional: URL ws:// explícita del endpoint CDP de Chrome.'),
      timeoutMs: z
        .number()
        .int()
        .min(5000)
        .max(120000)
        .default(60000)
        .describe('Tiempo de espera máximo en ms para la conexión CDP (permite aprobar el aviso de Chrome 144+).'),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  runTool(async ({ cookieHeader, logosUserId, userDataDir, wsEndpoint, timeoutMs }) => {
    const syncInfo = cookieHeader
      ? await saveSession({ cookieHeader, logosUserId, source: 'manual-cookie-input' })
      : await syncSessionFromChrome({ userDataDir, wsEndpoint, timeoutMs });

    const status = await getStatus();
    return {
      synced: true,
      syncInfo,
      status,
    };
  })
);

async function main() {
  const subcommand = process.argv[2];
  if (subcommand === 'login' || subcommand === 'status') {
    const { runCli } = await import('./cli-login.mjs');
    const forwardedArgs =
      subcommand === 'status' ? ['--status', ...process.argv.slice(3)] : process.argv.slice(3);
    await runCli(forwardedArgs);
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
