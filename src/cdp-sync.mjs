import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractUserIdFromCookieHeader, saveSession } from './session.mjs';

const TARGET_COOKIE_URLS = [
  'https://app.logos.com',
  'https://faithlife.com',
  'https://www.logos.com',
];

/**
 * Minimal promise-based Chrome DevTools Protocol client over native Node WebSocket.
 */
class CdpClient {
  constructor(wsUrl, timeoutMs) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('Esta versión de Node.js no incluye WebSocket nativo.');
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        ws.close();
        reject(
          new Error(
            `Tiempo de espera agotado (${Math.round(this.timeoutMs / 1000)}s) conectando al puerto de depuración de Chrome.`
          )
        );
      }, this.timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });

      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`Error de WebSocket CDP: ${event?.message || 'conexión rechazada o bloqueada'}`));
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.id && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
              entry.reject(new Error(`CDP ${entry.method}: ${msg.error.message} (${msg.error.code})`));
            } else {
              entry.resolve(msg.result);
            }
          }
        } catch {
          // Ignore malformed frames
        }
      });

      ws.addEventListener('close', () => {
        for (const [id, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('La conexión CDP se cerró antes de completar la solicitud.'));
          this.pending.delete(id);
        }
      });
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Tiempo de espera agotado ejecutando CDP ${method}. Si Chrome 144+ mostró un cuadro de confirmación de depuración remota, acéptalo primero.`
          )
        );
      }, this.timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Returns candidate Chromium User Data directories for the current operating system.
 */
function getCandidateUserDataDirs(customDir) {
  const override = customDir || process.env.CHROME_USER_DATA_DIR;
  if (override) return [override];

  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(localAppData, 'Google', 'Chrome', 'User Data'),
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      path.join(localAppData, 'Chromium', 'User Data'),
    ];
  }

  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    return [
      path.join(appSupport, 'Google', 'Chrome'),
      path.join(appSupport, 'Microsoft Edge'),
      path.join(appSupport, 'BraveSoftware', 'Brave-Browser'),
      path.join(appSupport, 'Chromium'),
    ];
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(configHome, 'google-chrome'),
    path.join(configHome, 'microsoft-edge'),
    path.join(configHome, 'BraveSoftware', 'Brave-Browser'),
    path.join(configHome, 'chromium'),
  ];
}

/**
 * Resolves Chrome/Edge/Brave's active DevTools WebSocket endpoint via DevToolsActivePort or HTTP /json/version.
 */
async function resolveWsEndpoint({ userDataDir, wsEndpoint }) {
  if (wsEndpoint || process.env.CHROME_WS_ENDPOINT) {
    return wsEndpoint || process.env.CHROME_WS_ENDPOINT;
  }

  const candidateDirs = getCandidateUserDataDirs(userDataDir);
  for (const dir of candidateDirs) {
    const activePortPath = path.join(dir, 'DevToolsActivePort');
    try {
      const raw = await fs.readFile(activePortPath, 'utf8');
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      if (lines.length >= 2 && /^\d+$/.test(lines[0])) {
        return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
      }
    } catch {
      // Try next browser profile directory
    }
  }

  // Fallback for browsers started explicitly with --remote-debugging-port=9222
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version', {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const info = await res.json();
      if (info?.webSocketDebuggerUrl) {
        return info.webSocketDebuggerUrl;
      }
    }
  } catch {
    // No HTTP remote debugging listener on port 9222
  }

  throw new Error(
    `No se encontró DevToolsActivePort ni puerto 9222 activo (rutas revisadas: ${candidateDirs.join(', ')}). ` +
      'Activa la depuración remota en chrome://inspect/#remote-debugging (o edge://inspect/#remote-debugging) o pega tu Cookie manualmente.'
  );
}

/**
 * Synchronizes authenticated Logos cookies from the user's open Chrome instance via CDP.
 */
export async function syncSessionFromChrome({
  userDataDir,
  wsEndpoint,
  timeoutMs = 60000,
} = {}) {
  const endpoint = await resolveWsEndpoint({ userDataDir, wsEndpoint });
  const cdp = new CdpClient(endpoint, timeoutMs);

  try {
    await cdp.connect();
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    const logosTarget = targetInfos.find(
      (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('https://app.logos.com')
    );

    let cookies = [];
    if (logosTarget) {
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: logosTarget.targetId,
        flatten: true,
      });
      const res = await cdp.send('Network.getCookies', { urls: TARGET_COOKIE_URLS }, sessionId);
      cookies = res.cookies || [];
    } else {
      const res = await cdp.send('Storage.getCookies');
      cookies = (res.cookies || []).filter(
        (c) =>
          typeof c.domain === 'string' &&
          (c.domain.includes('logos.com') || c.domain.includes('faithlife.com'))
      );
    }

    // Prefer app.logos.com / .logos.com cookies if the same cookie name exists on multiple domains
    const byName = new Map();
    for (const cookie of cookies) {
      if (!cookie?.name) continue;
      const existing = byName.get(cookie.name);
      const isAppLogos = typeof cookie.domain === 'string' && cookie.domain.includes('logos.com');
      if (!existing || isAppLogos) {
        byName.set(cookie.name, cookie.value);
      }
    }

    if (!byName.has('auth2')) {
      throw new Error(
        'No se encontró la cookie de sesión "auth2" en Chrome. Abre https://app.logos.com e inicia sesión en tu cuenta antes de sincronizar.'
      );
    }

    const cookieHeader = Array.from(byName.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

    const logosUserId = extractUserIdFromCookieHeader(cookieHeader);
    return await saveSession({
      cookieHeader,
      logosUserId,
      source: 'chrome-cdp-sync',
    });
  } catch (err) {
    throw new Error(
      `No se pudo sincronizar automáticamente desde Chrome: ${err.message}. ` +
        'Opciones: (a) En Chrome abre chrome://inspect/#remote-debugging, asegúrate de que esté habilitado y acepta el diálogo de "Allow/Permitir" cuando aparezca; o (b) copia la cabecera Cookie de cualquier petición a app.logos.com desde DevTools y pásala en el parámetro cookieHeader de logos_sync_session.'
    );
  } finally {
    cdp.close();
  }
}
