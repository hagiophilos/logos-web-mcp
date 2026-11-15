import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { syncSessionFromChrome } from './cdp-sync.mjs';
import { getStatus } from './logos-client.mjs';
import { getSessionFilePath, saveSession } from './session.mjs';

/**
 * Parses CLI flags for login/status subcommands.
 */
function parseArgs(argv) {
  const args = { status: false, cdp: false, cookie: null, userId: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--status' || token === 'status') {
      args.status = true;
    } else if (token === '--cdp') {
      args.cdp = true;
    } else if (token === '--cookie' && argv[i + 1]) {
      args.cookie = argv[++i];
    } else if (token.startsWith('--cookie=')) {
      args.cookie = token.slice('--cookie='.length);
    } else if (token === '--user-id' && argv[i + 1]) {
      args.userId = argv[++i];
    }
  }
  return args;
}

/**
 * Reads either an empty Enter (CDP auto-sync) or a single/multi-line cookie/cURL string.
 */
async function promptCredentialInput() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('=== Configuración de sesión para logos-web-mcp ===');
    console.log(`La sesión se guardará de forma privada en: ${getSessionFilePath()}\n`);
    console.log('Opciones disponibles:');
    console.log('  1. Sincronización automática desde Chrome / Edge / Brave abierto');
    console.log('     (asegúrate de haber iniciado sesión en https://app.logos.com y tener');
    console.log('      habilitado chrome://inspect/#remote-debugging).');
    console.log('  2. Pegar la cabecera Cookie o comando "Copy as cURL" de DevTools (F12 -> Red');
    console.log('     -> cualquier petición a app.logos.com).\n');

    const firstLine = await rl.question(
      'Presiona [Enter] para sincronizar automáticamente, o pega tu Cookie / cURL aquí: '
    );
    const trimmed = firstLine.trim();
    if (!trimmed) {
      return null;
    }

    const lines = [firstLine];
    while (/[\\^]\s*$/.test(lines[lines.length - 1])) {
      lines[lines.length - 1] = lines[lines.length - 1].replace(/[\\^]\s*$/, ' ');
      const nextLine = await rl.question('> ');
      lines.push(nextLine);
    }
    return lines.join(' ').trim();
  } finally {
    rl.close();
  }
}

/**
 * Prints verified Logos account status after checking connectivity.
 */
async function printVerifiedStatus() {
  const status = await getStatus();
  console.log('\n[OK] Sesión verificada con https://app.logos.com');
  console.log(`  - Archivo de sesión : ${getSessionFilePath()}`);
  console.log(`  - ID de usuario     : ${status.logosUserId || '(no detectado)'}`);
  console.log(`  - Libros licenciados: ${status.totalLicensedBooks}`);
  console.log(`  - Formato de cita   : ${status.citationFormat || '(predeterminado)'}`);
  if (status.sampleBooks?.length) {
    console.log(`  - Primer libro      : ${status.sampleBooks[0].title} (${status.sampleBooks[0].resourceId})`);
  }
  return status;
}

/**
 * Entry point for CLI login and session status verification.
 */
export async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.status) {
    await printVerifiedStatus();
    return;
  }

  if (opts.cookie) {
    await saveSession({
      cookieHeader: opts.cookie,
      logosUserId: opts.userId,
      source: 'cli-cookie-flag',
    });
    await printVerifiedStatus();
    return;
  }

  if (opts.cdp) {
    console.log('Conectando con navegador Chromium vía CDP...');
    await syncSessionFromChrome({ timeoutMs: 60000 });
    await printVerifiedStatus();
    return;
  }

  const manualInput = await promptCredentialInput();
  if (manualInput) {
    await saveSession({
      cookieHeader: manualInput,
      logosUserId: opts.userId,
      source: 'cli-interactive-cookie',
    });
  } else {
    console.log('\nConectando con Chrome/Edge/Brave (si aparece un aviso en el navegador, haz clic en Permitir)...');
    await syncSessionFromChrome({ timeoutMs: 60000 });
  }

  await printVerifiedStatus();
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  runCli().catch((err) => {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  });
}
