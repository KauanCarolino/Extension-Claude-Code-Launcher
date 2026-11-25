'use strict';

// Gera as imagens do README (docs/images/) renderizando as páginas reais das views (media/*.js e *.css)
// num Chromium headless, com um estado de demonstração e as cores do tema Dark Modern do VS Code.
// Os diffs e rótulos saem do próprio out/ (diff.js, changes-view.js, i18n.js): rode `npm run compile` antes.
//
// Uso: node scripts/screenshots.cjs [--chrome /caminho/do/chrome] [--out docs/images]
// O Chromium do cache do Playwright (~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome) é achado sozinho.
// O GIF precisa do ffmpeg no PATH.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out');
const media = path.join(root, 'media');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function findChrome() {
  const explicit = argument('--chrome');
  if (explicit) return explicit;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const name of fs.existsSync(cache) ? fs.readdirSync(cache).filter((item) => item.startsWith('chromium-')).sort().reverse() : []) {
    for (const candidate of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const file = path.join(cache, name, candidate);
      if (fs.existsSync(file)) return file;
    }
  }
  throw new Error('Chromium não encontrado. Informe --chrome /caminho/do/chrome.');
}

// Dark Modern, o tema padrão do VS Code.
const THEME = {
  '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-textLink-foreground': '#4daafc',
  '--vscode-textLink-activeForeground': '#4daafc', '--vscode-focusBorder': '#0078d4', '--vscode-font-family': 'system-ui, "Ubuntu", "Segoe UI", sans-serif',
  '--vscode-font-size': '13px', '--vscode-editor-font-family': '"DejaVu Sans Mono", "Droid Sans Mono", monospace', '--vscode-editor-font-size': '12px',
  '--vscode-editor-background': '#1f1f1f', '--vscode-button-background': '#0078d4', '--vscode-button-foreground': '#ffffff', '--vscode-button-border': '#ffffff12',
  '--vscode-button-secondaryBackground': '#313131', '--vscode-button-secondaryForeground': '#cccccc', '--vscode-button-secondaryHoverBackground': '#3c3c3c',
  '--vscode-input-background': '#313131', '--vscode-input-foreground': '#cccccc', '--vscode-input-border': '#3c3c3c', '--vscode-input-placeholderForeground': '#989898',
  '--vscode-panel-border': '#2b2b2b', '--vscode-list-hoverBackground': '#2a2d2e', '--vscode-list-inactiveSelectionBackground': '#37373d',
  '--vscode-toolbar-hoverBackground': '#5a5d5e50', '--vscode-badge-background': '#616161', '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-editorLineNumber-foreground': '#6e7681', '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-gitDecoration-addedResourceForeground': '#81b88b', '--vscode-gitDecoration-deletedResourceForeground': '#c74e39',
  '--vscode-gitDecoration-modifiedResourceForeground': '#e2c08d', '--vscode-diffEditor-insertedTextBackground': '#9ccc2c33',
  '--vscode-diffEditor-insertedLineBackground': '#9bb95526', '--vscode-diffEditor-removedTextBackground': '#ff000033',
  '--vscode-diffEditor-removedLineBackground': '#ff000026', '--vscode-claudeCodeLauncher-pendingChangeForeground': '#d98c5f',
};

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

/** Textos da demonstração nos dois idiomas; o conteúdo dos arquivos é o mesmo. */
const COPY = {
  en: {
    request: 'Add rate limiting to the login endpoint', older: 'Fix the typo in the README',
    reasonMiddleware: "I'll add a small middleware that limits login attempts per IP, then wire it into the auth route.",
    reasonRoute: 'Now I use the limiter on the login route.', reasonInstall: 'The middleware needs express-rate-limit, so I installed it.',
    reasonReadme: 'Fixing the spelling of "authentication".', chat: 'Add rate limiting to login',
    sessions: ['Add rate limiting to login', 'Fix the typo in the README', 'Write tests for the session store', 'Explain the deploy script', 'Upgrade to Node 22'],
  },
  'pt-br': {
    request: 'Adicione limite de tentativas no login', older: 'Corrija o erro de digitação no README',
    reasonMiddleware: 'Vou criar um middleware pequeno que limita as tentativas de login por IP e depois ligá-lo à rota de autenticação.',
    reasonRoute: 'Agora uso o limitador na rota de login.', reasonInstall: 'O middleware precisa do express-rate-limit, então instalei o pacote.',
    reasonReadme: 'Corrigindo a grafia de "autenticação".', chat: 'Adicione limite de tentativas no login',
    sessions: ['Adicione limite de tentativas no login', 'Corrija o erro de digitação no README', 'Escreva testes para o armazenamento de sessão', 'Explique o script de deploy', 'Atualize para o Node 22'],
  },
};

const FILES = {
  middlewareAfter: "import rateLimit from 'express-rate-limit';\n\n/** At most 5 login attempts per IP every 15 minutes. */\nexport const loginLimiter = rateLimit({\n  windowMs: 15 * 60 * 1000,\n  limit: 5,\n  standardHeaders: 'draft-7',\n  legacyHeaders: false,\n  message: { error: 'Too many login attempts. Try again later.' },\n});\n",
  routeBefore: "import { Router } from 'express';\nimport { login, logout } from '../controllers/auth';\n\nconst router = Router();\n\nrouter.post('/login', login);\nrouter.post('/logout', logout);\n\nexport default router;\n",
  routeAfter: "import { Router } from 'express';\nimport { login, logout } from '../controllers/auth';\nimport { loginLimiter } from '../middleware/rateLimit';\n\nconst router = Router();\n\nrouter.post('/login', loginLimiter, login);\nrouter.post('/logout', logout);\n\nexport default router;\n",
  packageBefore: '{\n  "name": "acme-api",\n  "version": "2.4.0",\n  "dependencies": {\n    "express": "^4.21.2",\n    "jsonwebtoken": "^9.0.2"\n  }\n}\n',
  packageAfter: '{\n  "name": "acme-api",\n  "version": "2.4.0",\n  "dependencies": {\n    "express": "^4.21.2",\n    "express-rate-limit": "^7.5.0",\n    "jsonwebtoken": "^9.0.2"\n  }\n}\n',
  readmeBefore: '# acme-api\n\nREST API with JWT authentcation.\n',
  readmeAfter: '# acme-api\n\nREST API with JWT authentication.\n',
};

function demo(language) {
  const i18n = require(path.join(out, 'i18n.js'));
  i18n.configureLanguage(language, root);
  // changes-view lê os rótulos na hora: precisa vir depois do idioma.
  delete require.cache[require.resolve(path.join(out, 'changes-view.js'))];
  const { toViewEntry } = require(path.join(out, 'changes-view.js'));
  const copy = COPY[language];
  const snap = (text) => text === undefined ? { exists: false, text: null, large: false } : { exists: true, text, large: false };
  const raw = (id, file, tool, before, after, minutes) => ({ id, time: minutesAgo(minutes), session: 's1', tool, file: '/acme-api/' + file, before: snap(before), after: snap(after) });
  const items = [
    [raw('e4', 'package.json', 'Command', FILES.packageBefore, FILES.packageAfter, 2), 'r1', copy.reasonInstall, null],
    [raw('e3', 'src/routes/auth.ts', 'Edit', FILES.routeBefore, FILES.routeAfter, 3), 'r1', copy.reasonRoute, null],
    [raw('e2', 'src/middleware/rateLimit.ts', 'Write', undefined, FILES.middlewareAfter, 4), 'r1', copy.reasonMiddleware, null],
    [raw('e1', 'README.md', 'Edit', FILES.readmeBefore, FILES.readmeAfter, 40), 'r0', copy.reasonReadme, 'accepted'],
  ];
  const entries = items.map(([entry, requestId, reason, status]) => ({
    ...toViewEntry(entry, entry.file.slice('/acme-api/'.length)), reason, status, requestId,
    request: requestId === 'r1' ? copy.request : copy.older, phase: status ? 'complete' : 'pending', revision: 1,
    acceptedParts: status ? 1 : 0, rejectedParts: 0, pendingParts: status ? 0 : 1,
  }));
  const files = entries.filter((entry) => !entry.status).map((entry) => ({
    id: entry.id, key: '/acme-api/' + entry.dir + '/' + entry.file, file: entry.file, dir: entry.dir, added: entry.added + entry.modified,
    removed: entry.removed + entry.modified, created: entry.actionKind === 'created' || entry.id === 'e2', deleted: false, revision: 1, phase: 'pending',
    acceptedParts: 0, rejectedParts: 0, pendingParts: 1,
  }));
  const configured = { workspace: 1, configuration: 'configured', configurationLabel: '', capabilityLabel: '', evidenceLabel: '', coverageLabel: '', observation: null, completion: null };
  const state = { type: 'state', hasFolder: true, enabled: true, entries, files, chat: { title: copy.chat, scoped: true, matches: 1, others: 0, unclaimed: 0 },
    canUndo: false, shell: null, captureHealth: [], reviewWriter: true, readOnlyReason: null, coverageMessage: null, _configured: configured };
  const accepted = { ...state, files: [], entries: entries.map((entry) => ({ ...entry, status: 'accepted', phase: 'complete', pendingParts: 0, acceptedParts: 1 })) };
  const home = { type: 'state', installed: true, hasFolder: true, coverageMessage: null,
    openTabs: [{ key: '1:0:chat', label: copy.sessions[0], active: true }],
    sessions: copy.sessions.slice(1).map((title, index) => ({ id: 'session-' + index, title, updated: Date.now() - [40, 300, 1500, 4000][index] * 60000, open: false })) };
  const t = i18n.t, kind = (name) => i18n.t({ allow: 'permitir', ask: 'perguntar', deny: 'negar' }[name]);
  const permissions = { type: 'catalog', kind: 'permissions', hasProject: true, problems: [],
    notes: [t('Negar vence perguntar, que vence permitir. As regras da organização (managed-settings.json) valem acima das demais.'), t('Modo padrão ({0}): {1}', t('Projeto'), 'acceptEdits')],
    items: [
      { id: '1', name: 'Bash(npm test:*)', scope: 'local', state: 'active', canDelete: true, tags: [{ text: kind('allow'), tone: '' }] },
      { id: '2', name: 'Read(./src/**)', scope: 'local', state: 'active', canDelete: true, tags: [{ text: kind('allow'), tone: '' }] },
      { id: '3', name: 'Bash(git push:*)', scope: 'project', state: 'active', canDelete: true, tags: [{ text: kind('ask'), tone: 'off' }] },
      { id: '4', name: 'Read(./.env)', scope: 'project', state: 'active', canDelete: true, tags: [{ text: kind('deny'), tone: 'broken' }] },
      { id: '5', name: 'WebFetch(domain:docs.acme.dev)', scope: 'user', state: 'active', canDelete: true, tags: [{ text: kind('allow'), tone: '' }] },
    ] };
  return { state, accepted, home, permissions, dictionary: i18n.webviewDictionaryScript(), lang: i18n.htmlLanguage() };
}

function page(file, { lang, dictionary, scripts, styles, saved, messages, background, width }) {
  const url = (name) => pathToFileURL(path.join(media, name)).href;
  const theme = Object.entries(THEME).map(([key, value]) => `${key}: ${value};`).join(' ');
  fs.writeFileSync(file, `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="UTF-8" />
<link rel="stylesheet" href="${url('codicons/codicon.css')}" />
${styles.map((name) => `<link rel="stylesheet" href="${url(name)}" />`).join('\n')}
<style>:root { ${theme} } html { background: ${background}; } body { width: ${width}px; }</style>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, setState() {}, getState: () => (${JSON.stringify(saved)}) });</script>
</head><body>
<div id="root"></div>
${dictionary}
<script src="${url('l10n.js')}"></script>
${scripts.map((name) => `<script src="${url(name)}"></script>`).join('\n')}
<script>${messages.map((message) => `window.postMessage(${JSON.stringify(message)}, '*');`).join('\n')}</script>
</body></html>`);
}

function shoot(chrome, html, png, width, height) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-shot-profile-'));
  try {
    const result = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--force-device-scale-factor=2', `--window-size=${width},${height}`,
      '--virtual-time-budget=4000', `--screenshot=${png}`, pathToFileURL(html).href], { encoding: 'utf8', timeout: 60000 });
    if (result.status !== 0 || !fs.existsSync(png)) throw new Error('Chromium falhou em ' + path.basename(png) + ':\n' + (result.stderr || '').slice(-2000));
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}

function main() {
  const chrome = findChrome();
  const target = path.resolve(root, argument('--out', 'docs/images'));
  fs.mkdirSync(target, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-shots-'));
  const changes = { scripts: ['changes.js'], styles: ['base.css', 'changes.css'] };
  const homeView = { scripts: ['skills.js', 'catalog.js', 'home.js'], styles: ['base.css', 'home.css', 'skills.css'] };
  const sidebar = '#181818', editor = '#1f1f1f';
  const produced = [];
  try {
    for (const language of ['en', 'pt-br']) {
      const data = demo(language), suffix = language === 'en' ? '' : '.pt-br';
      const shots = [
        { name: 'changes-panel', ...changes, width: 1100, height: 900, background: editor, saved: { openCards: ['e4', 'e3'], filesOpen: true, layout: 'unified' },
          messages: [{ ...data.state, wide: true, captureHealth: [data.state._configured] }] },
        { name: 'changes-sidebar', ...changes, width: 380, height: 760, background: sidebar, saved: { openCards: [], filesOpen: true },
          messages: [{ ...data.state, wide: false, captureHealth: [data.state._configured] }] },
        { name: 'conversations', ...homeView, width: 380, height: 420, background: sidebar, saved: { tab: 'chats' }, messages: [data.home] },
        { name: 'permissions', ...homeView, width: 380, height: 560, background: sidebar, saved: { tab: 'permissions' }, messages: [data.home, data.permissions] },
      ];
      if (language === 'en') {
        shots.push(
          { name: 'frame-1', ...changes, width: 1100, height: 760, background: editor, saved: { openCards: ['e2'], filesOpen: true, layout: 'unified' }, messages: [{ ...data.state, wide: true, captureHealth: [data.state._configured] }] },
          { name: 'frame-2', ...changes, width: 1100, height: 760, background: editor, saved: { openCards: ['e3'], filesOpen: true, layout: 'unified' }, messages: [{ ...data.state, wide: true, captureHealth: [data.state._configured] }] },
          { name: 'frame-3', ...changes, width: 1100, height: 760, background: editor, saved: { openCards: ['e3'], filesOpen: true, layout: 'split' }, messages: [{ ...data.state, wide: true, captureHealth: [data.state._configured] }] },
          { name: 'frame-4', ...changes, width: 1100, height: 760, background: editor, saved: { openCards: ['e4'], filesOpen: true, layout: 'split' }, messages: [{ ...data.state, wide: true, captureHealth: [data.state._configured] }] },
          { name: 'frame-5', ...changes, width: 1100, height: 760, background: editor, saved: { openCards: [], filesOpen: true, layout: 'split' }, messages: [{ ...data.accepted, wide: true, captureHealth: [data.state._configured] }] },
        );
      }
      for (const shot of shots) {
        const html = path.join(temp, shot.name + suffix + '.html');
        page(html, { ...shot, lang: data.lang, dictionary: data.dictionary });
        const png = shot.name.startsWith('frame-') ? path.join(temp, shot.name + '.png') : path.join(target, shot.name + suffix + '.png');
        shoot(chrome, html, png, shot.width, shot.height);
        if (!shot.name.startsWith('frame-')) produced.push(path.relative(root, png));
      }
    }
    const gif = path.join(target, 'review.gif');
    const ffmpeg = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '0.55', '-i', path.join(temp, 'frame-%d.png'),
      '-vf', 'fps=8,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none', '-loop', '0', gif], { encoding: 'utf8' });
    if (ffmpeg.status === 0) produced.push(path.relative(root, gif));
    else console.warn('GIF não gerado (ffmpeg): ' + (ffmpeg.error ? ffmpeg.error.message : ffmpeg.stderr));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(produced.join('\n'));
}

main();
