# `logos-web-mcp`

Servidor **Model Context Protocol (MCP)** que conecta **Gemini (Antigravity)**, **Claude Desktop** y **Claude Code** con tu cuenta autenticada de **Logos / Faithlife Web** (`https://app.logos.com`), convirtiendo tu biblioteca digital en un asistente de investigación teológica y bíblica que busca en tus libros licenciados, lee capítulos completos y cita con referencias exactas y enlaces directos.

---

## Características principales

- **Sin contraseñas almacenadas:** Reutiliza la sesión ya autenticada en tu navegador (`Chrome`, `Edge`, `Brave` o `Chromium`) en `https://app.logos.com`.
- **Sesión aislada del código:** Tus cookies se guardan fuera del proyecto en `~/.logos-web-mcp/session.json` (con permisos restringidos `0600`), por lo que puedes compartir o subir la carpeta sin exponer credenciales.
- **Multiplataforma:** Compatible con **Windows**, **macOS** y **Linux**.
- **Protección de créditos de IA:** `logos_search_library` usa por defecto `mode: "precise"` (búsqueda léxica clásica sin gasto de créditos de IA de Logos). `mode: "smart"` queda opcional bajo demanda.

---

## Requisitos

- **Node.js 18+** (recomendado 20+).
- Cuenta activa de Logos con acceso web en [`https://app.logos.com`](https://app.logos.com).

---

## Instalación rápida

1. Clona o descarga este repositorio y entra en la carpeta:

```bash
cd logos-web-mcp
npm install
```

2. Inicia sesión una vez conectando tu sesión web de Logos:

```bash
npm run login
```

El asistente `npm run login` te ofrece dos formas de conectarte:

- **Opción A — Automática desde tu navegador abierto (CDP):**
  1. Abre tu navegador (`Chrome`, `Edge`, `Brave` o `Chromium`), entra en `https://app.logos.com` e inicia sesión.
  2. Habilita la depuración remota en `chrome://inspect/#remote-debugging` (o `edge://inspect/#remote-debugging`).
  3. Presiona `Enter` en la terminal; si el navegador muestra un cuadro pidiendo confirmar el acceso, haz clic en **Permitir / Allow**.
- **Opción B — Manual desde DevTools (`Copy as cURL` o `Cookie`):**
  1. Abre `https://app.logos.com` en tu navegador (sesión iniciada) y presiona `F12` → pestaña **Red / Network**.
  2. Haz clic en cualquier petición a `app.logos.com` → **Copiar → Copiar como cURL** (o copia el valor de la cabecera `Cookie`).
  3. Pégalo cuando `npm run login` te lo pida (también acepta `npm run login -- --cookie "auth2=...; ..."`).

3. Verifica que todo esté conectado correctamente:

```bash
npm run status
```

Opcionalmente, ejecuta la prueba end-to-end contra tu propia biblioteca:

```bash
npm test
```

---

## Configuración en tu cliente de IA

Sustituye la ruta al archivo `src/index.mjs` por la ubicación real donde descargaste `logos-web-mcp`:

- **Windows:** `C:\\ruta\\a\\logos-web-mcp\\src\\index.mjs` (con `command`: `"node"` o `"C:\\Program Files\\nodejs\\node.exe"`)
- **macOS / Linux:** `/ruta/a/logos-web-mcp/src/index.mjs` (con `command`: `"node"` o la ruta completa de `which node`)

### 1. Claude Desktop

Edita tu archivo `claude_desktop_config.json` (consulta [`claude_desktop_config.example.json`](./claude_desktop_config.example.json)):

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "logos-web": {
      "command": "node",
      "args": [
        "/ruta/absoluta/a/logos-web-mcp/src/index.mjs"
      ]
    }
  }
}
```

### 2. Gemini / Antigravity

Edita `~/.gemini/config/mcp_config.json` (consulta [`gemini_mcp_config.example.json`](./gemini_mcp_config.example.json)) agregando `"logos-web"` dentro de `"mcpServers"`.

### 3. Claude Code (CLI)

```bash
claude mcp add logos-web -- node /ruta/absoluta/a/logos-web-mcp/src/index.mjs
```

> Después de editar la configuración, reinicia Claude Desktop o recarga los servidores MCP en Antigravity.

---

## Herramientas y metodología de investigación en 4 pasos

El servidor incluye instrucciones de protocolo y el prompt `logos_investigar` para que Gemini y Claude sigan automáticamente un flujo académico de 4 pasos ante cualquier pregunta bíblica, teológica o homilética:

1. **Entender la pregunta:** Desglosa el tema en términos clave bilingües (español e inglés).
2. **Evaluar los recursos más apropiados:** Prioriza comentarios, diccionarios, manuales de hermenéutica/homilética y monografías de tu biblioteca licenciada.
3. **Colectar la información y citas:** Extrae el contexto expandido alrededor de cada pasaje y genera citas bibliográficas oficiales directamente desde el motor de Logos (`/api/app/resources/citation/render`).
4. **Entregar síntesis citada con referencias:** Combina explicación redactada con ejemplos concretos, citas numeradas inline (`[\[1\]](https://ref.ly/logosres/...)`), referencias bíblicas enlazadas y bibliografía completa con enlaces directos al rango exacto (`app.logos.com/.../textranges/...`).

| Herramienta | Qué hace |
| :--- | :--- |
| `logos_research_topic` | Orquesta el flujo de investigación de 4 pasos: ejecuta múltiples consultas bilingües, evalúa y diversifica libros licenciados, extrae ventanas de contexto alrededor de cada hallazgo y genera citas bibliográficas oficiales `[1]..[N]` listas para citar (`mode: "precise"` por defecto, sin gastar créditos de IA). |
| `logos_render_citations` | Genera citas bibliográficas académicas oficiales de Logos (`sbl-v2`, `turabian-author-date`, etc.) con enlaces `ref.ly` y `textranges` para uno o varios pasajes. |
| `logos_status` | Verifica la sesión activa en `app.logos.com`, muestra el ID de usuario, formato de cita, total de libros licenciados y muestra del catálogo. |
| `logos_list_books` | Lista y filtra libros licenciados en tu biblioteca (`lang:es`, `type:bible`, `type:commentary`, `author:...`) y puede devolver ficha bibliográfica e índice (`tableofcontents`). |
| `logos_search_library` | Busca dentro de tus libros (`scope: "books"`) o Biblias (`scope: "bible"`). Devuelve fragmentos resaltados, `displayReference`, `articleId`, `offset` y enlaces `app.logos.com` y `ref.ly`. Usa `mode: "precise"` por defecto (sin consumir créditos de IA). |
| `logos_read_resource` | Lee el texto íntegro (o una ventana `contextChars` centrada en `offset`) de un capítulo, artículo, página (`page.520`), versículo (`bible.66.3.25`), entrada de diccionario (`headword`) u `offset`, incluyendo `[Page N]`, referencias bíblicas y `previousArticleId` / `nextArticleId`. |
| `logos_sync_session` | Renueva `~/.logos-web-mcp/session.json` vía navegador (CDP) o pasando `cookieHeader`. |

---

## Variables de entorno opcionales

- `LOGOS_SESSION_PATH`: Ruta alternativa para `session.json` (por defecto `~/.logos-web-mcp/session.json`).
- `LOGOS_COOKIE_HEADER`: Inyecta la cabecera `Cookie` directamente por entorno sin archivo local.
- `CHROME_USER_DATA_DIR`: Ruta personalizada del perfil de navegador Chromium donde buscar `DevToolsActivePort`.
- `CHROME_WS_ENDPOINT`: URL `ws://127.0.0.1:9222/devtools/browser/...` explícita para CDP.
