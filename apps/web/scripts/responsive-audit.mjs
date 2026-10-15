/**
 * Responsive audit of the OGC web app in a real browser (headless Chrome via
 * the DevTools protocol — no extra dependencies).
 *
 * For each route and viewport it records: horizontal page overflow, elements
 * that extend outside the viewport (not inside a scroll container), and a
 * screenshot. It seeds realistic data through the public API and the real
 * end-to-end encryption engine, then signs the browser in.
 *
 * Prerequisites: the API (`pnpm --filter @ogc/api dev`) and web dev server
 * (`pnpm --filter @ogc/web dev`) are running against a development database,
 * and `pnpm build` has produced `packages/*\/dist`. Development data only.
 *
 * Usage (from the repository root):
 *   node apps/web/scripts/responsive-audit.mjs [outputDir]
 * Environment: CHROME_PATH, WEB_ORIGIN (default http://localhost:5173),
 *   ACTIVATE_SQL_CONTAINER (default ogc-postgres-1); for a quicker partial run,
 *   AUDIT_WIDTHS (e.g. `320,768`) and AUDIT_ROUTES (substrings, e.g. `messages,channels`).
 */
/* global process, Buffer */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(process.argv[2] ?? join(tmpdir(), 'ogc-responsive'));
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const API = `${ORIGIN}/api/v1`;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PG = process.env.ACTIVATE_SQL_CONTAINER ?? 'ogc-postgres-1';
const PASSWORD = 'correct horse battery staple';
const PORT = 9333;

/** Width × height; phones also in landscape. */
export const VIEWPORTS = [
  [320, 640],
  [360, 740],
  [375, 667],
  [390, 844],
  [430, 932],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
  [740, 360],
  [844, 390],
];

const onlyWidths = process.env.AUDIT_WIDTHS?.split(',').map(Number);
const onlyRoutes = process.env.AUDIT_ROUTES?.split(',');
const viewports = VIEWPORTS.filter(([w]) => !onlyWidths || onlyWidths.includes(w));
const wanted = (path) => !onlyRoutes || onlyRoutes.some((r) => path.includes(r));

const load = (path) => import(pathToFileURL(join(ROOT, path)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- API seeding
async function call(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.message ?? ''}`);
  return json;
}

const psql = (sql) =>
  execFileSync('docker', ['exec', PG, 'psql', '-U', 'ogc', '-d', 'ogc', '-qtAc', sql])
    .toString()
    .trim();

async function account(name) {
  const email = `audit-${name.split(' ')[0].toLowerCase()}-${Date.now()}@example.test`;
  await call('POST', '/auth/register', { body: { email, password: PASSWORD, displayName: name } });
  psql(`UPDATE users SET status='ACTIVE', email_verified_at=now() WHERE email='${email}'`);
  const login = await call('POST', '/auth/login', {
    body: { email, password: PASSWORD, device: { platform: 'ANDROID' } },
  });
  return { email, token: login.tokens.accessToken, ogcId: login.account.ogcId };
}

async function engineFor(user) {
  const { MessagingClient, SealedStore, MemoryKeyValueStore, TransportError } = await load(
    'packages/messaging/dist/index.js',
  );
  const { rawKeySealer } = await load('packages/e2ee/dist/index.js');
  const t = async (method, path, body) => {
    try {
      return await call(method, path, { token: user.token, body });
    } catch (error) {
      const status = Number(/: (\d{3})/.exec(String(error))?.[1] ?? 0);
      throw new TransportError(String(error), status);
    }
  };
  const transport = {
    registerDeviceKey: (k) => t('PUT', '/e2ee/device-key', { signaturePublicKey: k }),
    currentDeviceKey: () => t('GET', '/e2ee/device-key').catch(() => null),
    uploadKeyPackages: (keyPackages) => t('POST', '/e2ee/key-packages', { keyPackages }),
    welcomes: () => t('GET', '/e2ee/welcomes'),
    acknowledgeWelcome: (id) => t('DELETE', `/e2ee/welcomes/${id}`),
    listConversations: (c) => t('GET', `/conversations${c ? `?cursor=${c}` : ''}`),
    conversationChanges: (s) => t('GET', `/conversations/changes${s ? `?since=${s}` : ''}`),
    openConversation: (ogcId) => t('POST', '/conversations', { ogcId }),
    conversation: (id) => t('GET', `/conversations/${id}`),
    directory: (id) => t('GET', `/conversations/${id}/devices`),
    mlsGroup: (id) => t('GET', `/conversations/${id}/mls`),
    claimKeyPackages: (id, ids) =>
      t('POST', `/conversations/${id}/mls/key-packages`, { deviceKeyIds: ids }),
    submitCommit: (id, c) => t('POST', `/conversations/${id}/mls/commits`, c),
    sendMessage: (id, m) => t('POST', `/conversations/${id}/messages`, m),
    editMessage: (id, e) => t('PATCH', `/messages/${id}`, e),
    deleteMessage: (id, s) => t('DELETE', `/messages/${id}?scope=${s}`),
    react: (id, r, add) => t(add ? 'PUT' : 'DELETE', `/messages/${id}/reactions/${r}`),
    markRead: (id, seq) => t('POST', `/conversations/${id}/read`, { seq }),
    markDelivered: (id, seq) => t('POST', `/conversations/${id}/delivered`, { seq }),
    sync: (id, after, limit) =>
      t('GET', `/conversations/${id}/sync?after=${after}${limit ? `&limit=${limit}` : ''}`),
    history: (id) => t('GET', `/conversations/${id}/messages`),
    uploadAttachment: () => Promise.reject(new Error('unused')),
    downloadAttachment: () => Promise.reject(new Error('unused')),
  };
  const client = new MessagingClient(
    transport,
    new SealedStore(
      new MemoryKeyValueStore(),
      rawKeySealer(crypto.getRandomValues(new Uint8Array(32))),
    ),
    user.ogcId,
  );
  await client.start();
  return client;
}

async function befriend(a, b) {
  await call('POST', '/contacts/requests', { token: a.token, body: { ogcId: b.ogcId } });
  const incoming = await call('GET', '/contacts/requests/incoming', { token: b.token });
  await call('POST', `/contacts/requests/${incoming.items[0].id}/accept`, { token: b.token });
}

// ------------------------------------------------------------------- Chrome CDP
async function launchChrome() {
  const profile = join(tmpdir(), `ogc-chrome-${Date.now()}`);
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return { proc, wsUrl: page.webSocketDebuggerUrl };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else ok(msg.result);
    }
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  const send = async (method, params = {}) => {
    await ready;
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((ok, reject) => pending.set(msgId, { resolve: ok, reject }));
  };
  return { send, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

/**
 * Runs in the page. Reports:
 * - `overflow`: horizontal page scrolling (px);
 * - `offenders`: controls and text that extend past the viewport or are clipped by an
 *   ancestor (unless inside a container the user can scroll sideways), and dialogs that do
 *   not fit the viewport;
 * - `covered`: controls whose centre is hidden under another element (overlap), except
 *   content that scrolling can still bring out from under a fixed or sticky bar;
 * - `smallTargets`: controls under 32 px tall (informational).
 */
const MEASURE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const label = (el) => {
    const name = el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0].replace(/^_/, '').replace(/_[0-9a-z]+$/, '') : '');
    return name + ' "' + (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30) + '"';
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const sideScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };
  const clipper = (el, r) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(hidden|clip|auto|scroll)/.test(s.overflowX)) {
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.left < pr.left - 1) return p;
        return null;
      }
    }
    return null;
  };
  const dialogOpen = document.querySelector('[aria-modal="true"]');
  const scope = dialogOpen ?? document.body;
  const controls = [...scope.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], h1, h2, h3, p, label')].filter(visible);
  const offenders = [];
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    // Above the start of the page cannot be scrolled to.
    if (r.top < -1 && window.scrollY === 0 && !sideScroller(el)) { offenders.push('above page top ' + label(el) + ' [top ' + Math.round(r.top) + ']'); continue; }
    if (r.bottom < 0 || r.top > vh) continue; // further down: reachable by scrolling
    if (sideScroller(el)) continue;
    if (r.right > vw + 1 || r.left < -1) offenders.push('off-screen ' + label(el) + ' [' + Math.round(r.left) + '→' + Math.round(r.right) + ']');
    else if (/^(button|a|input|select|textarea)$/i.test(el.tagName) && clipper(el, r)) offenders.push('clipped ' + label(el));
  }
  for (const d of document.querySelectorAll('[role=dialog], [role=alertdialog]')) {
    const r = d.getBoundingClientRect();
    if (r.width && (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1)) offenders.push('dialog exceeds viewport ' + label(d) + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + ']');
  }
  // Content under a fixed bar is fine if scrolling can still bring it out from under it.
  const pinned = (n) => { for (let p = n; p && p !== document.body; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky') return p; } return null; };
  const canScroll = document.documentElement.scrollHeight - window.scrollY - vh > 1;
  // Content scrolled out of view inside its own scroll container (a message list, say).
  const scrolledOut = (el, r) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 1) { const pr = p.getBoundingClientRect(); return r.top + r.height / 2 < pr.top || r.top + r.height / 2 > pr.bottom; } } return false; };
  const covered = [];
  for (const el of controls.filter((e) => /^(button|a|input|select|textarea)$/i.test(e.tagName) || e.getAttribute('role') === 'button')) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 12);
    if (x < 0 || y < 0 || x > vw || y > vh) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || el.contains(hit) || hit.contains(el)) continue;
    if (el.closest('label') && el.closest('label').contains(hit)) continue;
    if (canScroll && pinned(hit) && !pinned(el)) continue;
    if (scrolledOut(el, r)) continue;
    covered.push(label(el) + ' under ' + label(hit));
  }
  const small = controls
    .filter((el) => /^(button|a|input|select|textarea)$/i.test(el.tagName) && el.getBoundingClientRect().height < 32)
    .map((el) => label(el));
  return {
    location: location.pathname,
    overflow: document.documentElement.scrollWidth - vw,
    offenders: [...new Set(offenders)].slice(0, 15),
    covered: [...new Set(covered)].slice(0, 10),
    smallTargets: [...new Set(small)].slice(0, 12),
  };
})()`;

/**
 * Runs in the page. Messaging must work one pane at a time on phones: the
 * conversation list or the open conversation (with a way back), and a
 * composer that is fully on screen and not covered (by the tab bar, say).
 */
const LAYOUT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight, problems = [];
  const shown = (el) => Boolean(el) && el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
  const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.top >= -1 && r.left >= -1 && r.bottom <= vh + 1 && r.right <= vw + 1; };
  const reachable = (el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(hit) && (el.contains(hit) || hit.contains(el)); };
  if (!location.pathname.startsWith('/messages') || document.querySelector('[aria-modal="true"]')) return problems;
  const open = !['/messages', '/messages/'].includes(location.pathname);
  const list = document.querySelector('section[aria-label="Conversations"]');
  if (vw < 900) {
    if (open && shown(list)) problems.push('phone: conversation list shown beside the open conversation');
    if (open && !shown(document.querySelector('a[aria-label="Back to conversations"]'))) problems.push('phone: no way back to the list');
    if (!open && !shown(list)) problems.push('phone: conversation list not shown');
  } else if (!shown(list)) problems.push('wide: conversation list not shown');
  if (open && shown(document.querySelector('[aria-label="Messages"]'))) {
    const controls = ['textarea[aria-label="Message"]', 'button[aria-label="Attach files"]', 'button[aria-label="Emoji"]'];
    for (const selector of controls) {
      const el = document.querySelector(selector);
      if (!shown(el)) problems.push('composer: missing ' + selector);
      else if (!onScreen(el)) problems.push('composer: off screen ' + selector);
      else if (!reachable(el)) problems.push('composer: covered ' + selector);
    }
  }
  return problems;
})()`;

let signIn;

/** Waits until the page has rendered content: no loading spinner, then a short settle. */
async function settle(cdp, minimum) {
  await sleep(minimum);
  for (let i = 0; i < 40; i++) {
    const loading = await evaluate(
      cdp,
      `document.readyState !== 'complete' || !document.querySelector('#root > *') || Boolean(document.querySelector('[class*="spinnerWrap"]'))`,
    );
    if (!loading) break;
    await sleep(250);
  }
  await sleep(300);
}

async function visit(cdp, path, [width, height], file, action) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 768 || height < 500,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 1024 });
  await cdp.send('Page.navigate', { url: `${ORIGIN}${path}` });
  await settle(cdp, 800);
  // A member page that landed on sign-in means the session was lost: sign in again and retry.
  if (signIn && (await evaluate(cdp, 'location.pathname')) === '/login') {
    await signIn();
    await cdp.send('Page.navigate', { url: `${ORIGIN}${path}` });
    await settle(cdp, 1500);
  }
  if (action) {
    await evaluate(cdp, action);
    await settle(cdp, 600);
  }
  const measured = { ...(await evaluate(cdp, MEASURE)), layout: await evaluate(cdp, LAYOUT) };
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, file), Buffer.from(shot.data, 'base64'));
  return measured;
}

const click = (text) =>
  `(() => { const el = [...document.querySelectorAll('button, a, [role=tab]')].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (el) el.click(); return Boolean(el); })()`;

// ------------------------------------------------------------------------- main
mkdirSync(OUT, { recursive: true });
const viewer = await account('Adaeze Okonkwo-Lovelace');
const bob = await account('Bartholomew Nwachukwu');
const carol = await account('Carol');
await befriend(viewer, bob);
await befriend(viewer, carol);

const { proc, wsUrl } = await launchChrome();
const cdp = connect(wsUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const report = [];

try {
  // Signed-out pages first.
  const guest = ['/', '/login', '/register', '/check-email', '/verify-email'];
  for (const vp of viewports) {
    for (const path of guest.filter(wanted)) {
      const name = `guest${path.replace(/\W+/g, '-')}-${vp[0]}x${vp[1]}.png`;
      report.push({ path, viewport: vp, ...(await visit(cdp, path, vp, name)) });
    }
  }

  // Sign in through the real web flow (HttpOnly cookies).
  signIn = async () => {
    await cdp.send('Page.navigate', { url: `${ORIGIN}/login` });
    await sleep(1200);
    await evaluate(
      cdp,
      `fetch('/api/v1/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-ogc-client': 'web' }, body: JSON.stringify({ email: ${JSON.stringify(viewer.email)}, password: ${JSON.stringify(PASSWORD)} }) }).then((r) => r.status)`,
    );
  };
  await signIn();
  // Let the browser create its device keys before others encrypt to it.
  await cdp.send('Page.navigate', { url: `${ORIGIN}/messages` });
  await sleep(6000);

  const bobEngine = await engineFor(bob);
  const direct = await bobEngine.openDirect(viewer.ogcId);
  await bobEngine.send(direct.id, {
    text: 'Hi! Here is a long message to check wrapping on narrow screens: https://example.test/a/really/long/link/that/should/wrap/without/pushing/the/layout/sideways and some more words after it.',
  });
  await bobEngine.send(direct.id, { text: 'Second message 👍' });

  const group = await call('POST', '/groups', {
    token: viewer.token,
    body: {
      name: 'Lagos–Nairobi Product Council',
      description: 'Weekly planning. Be kind.',
      invite: [bob.ogcId, carol.ogcId],
    },
  });
  for (const u of [bob]) {
    const inv = await call('GET', '/invitations', { token: u.token });
    await call('POST', `/invitations/${inv[0].id}/accept`, { token: u.token });
  }
  const carolInvite = await call('POST', '/groups', {
    token: carol.token,
    body: { name: 'Book club with a rather long name for testing' },
  });
  await befriend(carol, { ...viewer }).catch(() => undefined);
  await call('POST', `/groups/${carolInvite.conversation.id}/invitations`, {
    token: carol.token,
    body: { ogcIds: [viewer.ogcId] },
  }).catch(() => undefined);

  const channel = await call('POST', '/channels', {
    token: viewer.token,
    body: {
      handle: `audit${String(Date.now()).slice(-8)}`,
      name: 'Night Sky Watchers of West Africa',
      description: 'Astronomy news, events and photos from across the region.',
      postPolicy: 'ADMINS',
    },
  });
  await call('POST', `/channels/${channel.id}/join`, { token: bob.token });
  const first = await call('POST', `/channels/${channel.id}/posts`, {
    token: viewer.token,
    body: {
      clientPostId: crypto.randomUUID(),
      body: 'Perseids peak tonight — best viewing after midnight away from city lights. Bring a blanket!',
      announcement: true,
    },
  });
  await call('POST', `/channels/${channel.id}/posts`, {
    token: bob.token,
    body: {
      clientPostId: crypto.randomUUID(),
      body: 'Clear skies in Kano 🌌',
      replyToId: first.id,
    },
  });
  await call('PUT', `/channel-posts/${first.id}/pin`, { token: viewer.token });
  await call('PUT', `/channel-posts/${first.id}/reactions/heart`, { token: bob.token });
  await sleep(1500);

  const member = [
    ['/home'],
    ['/calls'],
    ['/communities'],
    ['/profile/edit'],
    ['/discover'],
    ['/contacts'],
    ['/settings/privacy'],
    ['/settings/blocked'],
    [`/id/${bob.ogcId}`],
    [`/report/${bob.ogcId}`],
    ['/messages'],
    [`/messages/${direct.id}`],
    [`/messages/${group.conversation.id}`],
    [`/messages/${group.conversation.id}`, 'info', click('Info')],
    ['/messages', 'new-group', click('New group')],
    ['/invitations'],
    ['/channels'],
    ['/channels', 'discover', click('Discover')],
    [`/channels/${channel.id}`],
    [`/channels/${channel.id}`, 'manage', click('Manage')],
    ['/notifications'],
    ['/join#token=ogc_inv_' + 'x'.repeat(43)],
  ];
  for (const vp of viewports) {
    for (const [path, label, action] of member.filter(([path, label]) =>
      wanted(`${path} ${label ?? ''}`),
    )) {
      const name = `${(label ? `${path}-${label}` : path).replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}-${vp[0]}x${vp[1]}.png`;
      report.push({
        path: label ? `${path} (${label})` : path,
        viewport: vp,
        ...(await visit(cdp, path, vp, name, action)),
      });
    }
  }
} finally {
  cdp.close();
  proc.kill();
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const defects = report.filter(
  (r) => r.overflow > 0 || r.offenders.length > 0 || r.covered.length > 0 || r.layout.length > 0,
);
const lost = report.filter(
  (r) =>
    !r.path.startsWith('/login') &&
    r.location === '/login' &&
    !['/', '/register', '/check-email', '/verify-email'].includes(r.path),
);
for (const l of lost) console.log(`NOT MEASURED (signed out) ${l.path} @${l.viewport.join('x')}`);
for (const d of defects) {
  console.log(
    `DEFECT ${d.path} @${d.viewport.join('x')}: overflow=${d.overflow}px ${[...d.offenders, ...d.covered, ...d.layout].join(' | ')}`,
  );
}
console.log(
  `\n${report.length} page views, ${defects.length} with layout defects. Screenshots: ${OUT}`,
);
process.exitCode = defects.length ? 1 : 0;
