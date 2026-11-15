import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const LEGACY_SESSION_PATH = path.join(PROJECT_ROOT, '.logos-session.json');
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * Returns the resolved path to the persisted Logos session JSON file.
 */
export function getSessionFilePath() {
  if (process.env.LOGOS_SESSION_PATH) {
    return path.resolve(process.env.LOGOS_SESSION_PATH);
  }
  return path.join(os.homedir(), '.logos-web-mcp', 'session.json');
}

/**
 * Extracts the numeric Logos user ID from known user-scoped cookies when present.
 */
export function extractUserIdFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    /(?:freeLicensesUnlockCompleted|lastLayout|webBibleStudyTheme)-(\d+)=/
  );
  if (match) return match[1];

  // didomi_dcs may carry base64 JSON {"o":"<userId>"} as its 3rd dot segment
  const didomi = cookieHeader.match(/didomi_dcs=[^.]*\.[^.]*\.([^.;]+)/);
  if (didomi) {
    try {
      const decoded = JSON.parse(Buffer.from(didomi[1], 'base64').toString('utf8'));
      if (decoded?.o && /^\d+$/.test(String(decoded.o))) {
        return String(decoded.o);
      }
    } catch {
      // Ignore malformed third-party cookie payloads
    }
  }
  return null;
}

/**
 * Normalizes a raw cookie string, cURL command, or JSON payload into a Cookie header string.
 */
export function parseCookieString(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Se requiere una cadena no vacía de cookies, comando curl o JSON.');
  }

  let candidate = raw.trim();

  if (candidate.startsWith('{') || candidate.startsWith('[')) {
    const parsed = JSON.parse(candidate);
    if (typeof parsed?.cookieHeader === 'string') {
      candidate = parsed.cookieHeader;
    } else if (Array.isArray(parsed?.cookies)) {
      candidate = parsed.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } else if (Array.isArray(parsed)) {
      candidate = parsed.map((c) => `${c.name}=${c.value}`).join('; ');
    } else if (parsed && typeof parsed === 'object') {
      candidate = Object.entries(parsed)
        .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }
  } else if (/^curl\b/i.test(candidate) || /-H\s+['"]cookie:/i.test(candidate) || /\s-b\s+['"]/.test(candidate)) {
    const headerMatch =
      candidate.match(/-H\s+(['"])\s*cookie:\s*([\s\S]*?)\1/i) ||
      candidate.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i);
    if (!headerMatch) {
      throw new Error('No se encontró cabecera Cookie (-H "cookie: ..." o -b "...") en el comando curl.');
    }
    candidate = headerMatch[2];
  } else if (/^cookie:\s*/i.test(candidate)) {
    candidate = candidate.replace(/^cookie:\s*/i, '');
  }

  candidate = candidate.replace(/[\r\n]+/g, ' ').trim();
  const pairs = candidate
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='));

  if (pairs.length === 0) {
    throw new Error('La cadena proporcionada no contiene cookies válidas con formato nombre=valor.');
  }

  return pairs.join('; ');
}

/**
 * Loads the authenticated Logos session from LOGOS_COOKIE_HEADER or .logos-session.json.
 */
export async function loadSession() {
  if (process.env.LOGOS_COOKIE_HEADER) {
    const cookieHeader = parseCookieString(process.env.LOGOS_COOKIE_HEADER);
    return {
      cookieHeader,
      logosUserId: extractUserIdFromCookieHeader(cookieHeader),
      userAgent: process.env.LOGOS_USER_AGENT || DEFAULT_USER_AGENT,
      updatedAt: null,
      source: 'env:LOGOS_COOKIE_HEADER',
    };
  }

  const filePath = getSessionFilePath();
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && filePath !== LEGACY_SESSION_PATH) {
      try {
        raw = await fs.readFile(LEGACY_SESSION_PATH, 'utf8');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, raw, { encoding: 'utf8', mode: 0o600 });
        await fs.unlink(LEGACY_SESSION_PATH).catch(() => {});
      } catch (legacyErr) {
        if (legacyErr.code === 'ENOENT') {
          throw new Error(
            `No hay sesión guardada en ${filePath}. Ejecuta "npm run login" o la herramienta logos_sync_session.`
          );
        }
        throw legacyErr;
      }
    } else if (err.code === 'ENOENT') {
      throw new Error(
        `No hay sesión guardada en ${filePath}. Ejecuta "npm run login" o la herramienta logos_sync_session.`
      );
    } else {
      throw err;
    }
  }

  const data = JSON.parse(raw);
  if (!data?.cookieHeader || typeof data.cookieHeader !== 'string') {
    throw new Error(`El archivo de sesión ${filePath} no contiene cookieHeader válido.`);
  }

  return {
    cookieHeader: data.cookieHeader,
    logosUserId: data.logosUserId || extractUserIdFromCookieHeader(data.cookieHeader),
    userAgent: data.userAgent || DEFAULT_USER_AGENT,
    updatedAt: data.updatedAt || null,
    source: data.source || filePath,
  };
}

/**
 * Persists authenticated Logos session metadata to ~/.logos-web-mcp/session.json.
 */
export async function saveSession({ cookieHeader, logosUserId, userAgent, source = 'manual' }) {
  const normalized = parseCookieString(cookieHeader);
  const resolvedUserId = logosUserId || extractUserIdFromCookieHeader(normalized);
  const payload = {
    logosUserId: resolvedUserId ? String(resolvedUserId) : null,
    cookieHeader: normalized,
    userAgent: userAgent || DEFAULT_USER_AGENT,
    updatedAt: new Date().toISOString(),
    source,
  };

  const filePath = getSessionFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  return {
    filePath,
    logosUserId: payload.logosUserId,
    updatedAt: payload.updatedAt,
    source: payload.source,
    hasAuthCookie: /(?:^|;\s*)auth2=/.test(normalized),
  };
}
