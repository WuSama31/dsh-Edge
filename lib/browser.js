/**
 * Edge/CDP driver: launches a debugging-enabled Edge, lists its tabs, and runs
 * page operations through the DevTools Protocol.
 *
 * Everything here is dependency free on purpose — the bundle is installed into
 * the DSH profile, where only Node builtins are guaranteed to resolve.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketClient } from './ws.js';

const DEFAULT_PORT = 9333;
const LAUNCH_TIMEOUT_MS = 25_000;
const NAVIGATION_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Expand %VAR% (Windows) and $VAR / ${VAR} (POSIX) references in a config path. */
function expandEnv(value) {
  return String(value)
    .replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match)
    .replace(/\$\{([^}]+)\}/g, (match, name) => process.env[name] ?? match)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => process.env[name] ?? match);
}

/** Give a bare host string an https:// scheme. */
function normalizeUrl(raw) {
  const value = String(raw).trim();
  if (value === '') throw new Error('url must be a non-empty string');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    if (/^javascript:/i.test(value)) throw new Error('javascript: URLs are not allowed here; use browser_eval instead');
    return value;
  }
  return `https://${value}`;
}

/** Resolve the default data directory for the isolated automation profile. */
function defaultProfileDir() {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'dsh-browser', 'edge-profile');
}

/** Resolve the default screenshot directory. */
function defaultOutputDir() {
  return path.join(os.homedir(), 'dsh-browser');
}

/** Candidate browser executables, best first. */
function candidateBrowserPaths() {
  const env = process.env;
  const roots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(
    (root) => typeof root === 'string' && root !== '',
  );
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  candidates.push(
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
  );
  return candidates;
}

function findBrowserExecutable(configured) {
  if (typeof configured === 'string' && configured !== '') {
    if (!fs.existsSync(configured)) throw new Error(`configured browserPath does not exist: ${configured}`);
    return configured;
  }
  for (const candidate of candidateBrowserPaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('could not find Microsoft Edge or Google Chrome; set "browserPath" in the plugin config');
}

/** One CDP connection: request/response correlation plus domain events. */
class Session {
  /** @param {WebSocketClient} client */
  constructor(client) {
    this.client = client;
    this.pending = new Map();
    this.nextId = 0;
    this.listeners = new Map();
    client.on('message', (message) => this.#onMessage(message));
    client.on('close', () => this.#onClose());
  }

  get closed() {
    return this.client.closed;
  }

  #onMessage(message) {
    if (message === null || typeof message !== 'object') return;
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(`${message.method ?? 'CDP'}: ${message.error.message} (${message.error.code})`));
      else entry.resolve(message.result ?? {});
      return;
    }
    for (const fn of this.listeners.get(message.method) ?? []) {
      try {
        fn(message.params ?? {});
      } catch {}
    }
  }

  #onClose() {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP connection closed'));
      this.pending.delete(id);
    }
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.client.closed) return Promise.reject(new Error('CDP connection is closed'));
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.client.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(method, fn) {
    const list = this.listeners.get(method);
    if (list === undefined) this.listeners.set(method, [fn]);
    else list.push(fn);
  }

  once(method, fn) {
    const wrapped = (payload) => {
      const list = this.listeners.get(method);
      if (list !== undefined) this.listeners.set(method, list.filter((item) => item !== wrapped));
      fn(payload);
    };
    this.on(method, wrapped);
  }

  close() {
    this.client.close();
  }
}

// ---------------------------------------------------------------------------
// Page-side programs. Each is stringified and evaluated in the tab, so it must
// stay self-contained: no imports, no references to module scope.
// ---------------------------------------------------------------------------

/** Extract readable content plus structure. */
function pageRead(options) {
  const opts = options ?? {};
  const maxChars = Math.min(400_000, Math.max(500, Number(opts.maxChars) || 20_000));
  const mode = opts.mode === 'full' ? 'full' : 'readable';
  const includeLinks = opts.includeLinks !== false;
  const includeTables = opts.includeTables === true;

  const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  const pickRoot = () => {
    const explicit = typeof opts.selector === 'string' && opts.selector !== '' ? document.querySelector(opts.selector) : null;
    if (explicit !== null) return explicit;
    const candidates = ['main', 'article', '[role="main"]', '#content', '.content', '.post', '.article'];
    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (element !== null && squash(element.innerText).length > 120) return element;
    }
    return document.body;
  };

  const blockText = (root) => {
    if (root === null) return '';
    let clone;
    try {
      clone = root.cloneNode(true);
    } catch {
      return squash(root.innerText);
    }
    for (const node of clone.querySelectorAll(
      'script,style,noscript,template,svg,canvas,iframe,video,audio,form,button,input,select,textarea,[aria-hidden="true"]',
    )) {
      node.remove();
    }
    const lines = [];
    const blocks = clone.querySelectorAll(
      'h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,pre,figcaption,dd,dt,summary,caption',
    );
    for (const block of blocks) {
      const text = squash(block.textContent);
      if (text !== '') lines.push(text);
    }
    return lines.join('\n');
  };

  const normalize = (raw) =>
    String(raw ?? '')
      .split('\n')
      .map((line) => squash(line))
      .filter((line) => line !== '')
      .join('\n');

  let text;
  if (mode === 'full') {
    text = normalize(document.body === null ? '' : document.body.innerText);
  } else {
    const root = pickRoot();
    text = normalize(blockText(root));
    if (text.length < 200 && document.body !== null) text = normalize(document.body.innerText);
  }

  const charCount = text.length;
  const truncated = charCount > maxChars;
  if (truncated) text = `${text.slice(0, maxChars)}\n…[truncated ${charCount - maxChars} chars]`;

  const headings = [];
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const value = squash(heading.innerText);
    if (value !== '') headings.push({ level: Number(heading.tagName.slice(1)), text: value.slice(0, 200) });
    if (headings.length >= 100) break;
  }

  const links = [];
  if (includeLinks) {
    const seen = new Set();
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.href;
      if (!href || href.startsWith('javascript:') || seen.has(href)) continue;
      const label = squash(anchor.innerText);
      if (label === '') continue;
      seen.add(href);
      links.push({ text: label.slice(0, 160), href });
      if (links.length >= 100) break;
    }
  }

  const tables = [];
  if (includeTables) {
    for (const table of document.querySelectorAll('table')) {
      const rows = [];
      for (const row of table.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('th,td')].map((cell) => squash(cell.innerText)).slice(0, 12);
        if (cells.length > 0) rows.push(cells);
        if (rows.length >= 40) break;
      }
      if (rows.length > 0) tables.push(rows);
      if (tables.length >= 5) break;
    }
  }

  const descriptionNode = document.querySelector('meta[name="description"],meta[property="og:description"]');

  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement === null ? '' : document.documentElement.lang || '',
    description: descriptionNode === null ? '' : squash(descriptionNode.getAttribute('content')),
    readyState: document.readyState,
    mode,
    text,
    charCount,
    truncated,
    headings,
    links,
    tables,
  };
}

/** Resolve a click target to viewport coordinates (or a DOM click fallback). */
function pageClickTarget(selector, text) {
  const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  let element = null;
  if (typeof selector === 'string' && selector !== '') {
    try {
      element = document.querySelector(selector);
    } catch (error) {
      return { ok: false, reason: `invalid selector: ${String(error)}` };
    }
  } else if (typeof text === 'string' && text !== '') {
    const wanted = squash(text);
    const nodes = document.querySelectorAll(
      'a,button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],input[type="submit"],input[type="button"],summary,label,li,td,th,span,div,strong,em,img',
    );
    const exact = [];
    const partial = [];
    for (const node of nodes) {
      const label = squash(node.innerText) || squash(node.getAttribute('aria-label')) || squash(node.getAttribute('title')) || squash(node.value);
      if (label === '') continue;
      if (label === wanted) exact.push(node);
      else if (partial.length < 200 && label.includes(wanted)) partial.push(node);
    }
    element = exact.length > 0 ? exact[0] : partial.length > 0 ? partial[0] : null;
  }
  if (element === null) return { ok: false, reason: 'no matching element' };

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  const label = squash(element.innerText) || squash(element.value) || squash(element.getAttribute('aria-label'));
  const base = { tag: element.tagName, text: label.slice(0, 120), href: element.href ?? '' };
  if (rect.width === 0 || rect.height === 0) {
    element.click();
    return { ok: true, method: 'dom-click', ...base };
  }
  return {
    ok: true,
    method: 'pointer',
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    ...base,
  };
}

/** Focus an input so Input.insertText lands in it. */
function pageFocus(selector) {
  let element;
  try {
    element = typeof selector === 'string' && selector !== '' ? document.querySelector(selector) : document.activeElement;
  } catch (error) {
    return { ok: false, reason: `invalid selector: ${String(error)}` };
  }
  if (element === null || element === undefined) return { ok: false, reason: 'no matching element' };
  if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  element.focus();
  const tag = element.tagName;
  if ((tag === 'INPUT' || tag === 'TEXTAREA') && typeof element.select === 'function') {
    try {
      element.select();
    } catch {}
  }
  if (element.isContentEditable === true) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    if (selection !== null) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  return { ok: true, tag, type: element.type ?? '', value: String(element.value ?? '').slice(0, 200) };
}

/** Select an option or set a value on a form control. */
function pageSetValue(selector, value) {
  let element;
  try {
    element = document.querySelector(selector);
  } catch (error) {
    return { ok: false, reason: `invalid selector: ${String(error)}` };
  }
  if (element === null) return { ok: false, reason: 'no matching element' };
  element.focus();
  if (element.tagName === 'SELECT') {
    element.value = value;
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: String(element.value) };
}

/** Current viewport scroll offset. */
function pageScrollBy(dx, dy) {
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    scrollWidth: Math.round(document.documentElement.scrollWidth),
    innerHeight: Math.round(window.innerHeight),
  };
}

/** Cheap probe used by browser_wait. */
function pageProbe(selector, text) {
  if (typeof selector === 'string' && selector !== '') {
    try {
      return document.querySelector(selector) !== null;
    } catch {
      return false;
    }
  }
  if (typeof text === 'string' && text !== '') {
    return document.body !== null && document.body.innerText.includes(text);
  }
  return true;
}

/** What a caller sees after an action: identity plus a short text preview. */
function pageSnapshot(previewChars) {
  const limit = Number(previewChars) || 800;
  const body = document.body;
  const raw = body === null ? '' : String(body.innerText ?? '');
  const text = raw.replace(/\n{3,}/g, '\n\n').trim();
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    preview: text.length > limit ? `${text.slice(0, limit)}…` : text,
    charCount: text.length,
  };
}

// ---------------------------------------------------------------------------

const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

export class EdgeBrowser {
  /** @param {Record<string, unknown>} rawConfig */
  constructor(rawConfig) {
    const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {};
    this.config = {
      port: Number.isInteger(config.port) ? config.port : DEFAULT_PORT,
      browserPath: typeof config.browserPath === 'string' && config.browserPath !== '' ? expandEnv(config.browserPath) : '',
      userDataDir:
        typeof config.userDataDir === 'string' && config.userDataDir !== '' ? path.resolve(expandEnv(config.userDataDir)) : defaultProfileDir(),
      outputDir:
        typeof config.outputDir === 'string' && config.outputDir !== '' ? path.resolve(expandEnv(config.outputDir)) : defaultOutputDir(),
      headless: config.headless === true,
      windowSize: typeof config.windowSize === 'string' ? config.windowSize : '1440,960',
      navigationTimeoutMs: Number.isInteger(config.navigationTimeoutMs) ? config.navigationTimeoutMs : NAVIGATION_TIMEOUT_MS,
      maxChars: Number.isInteger(config.maxChars) ? config.maxChars : 20_000,
    };
    this.child = undefined;
    this.exitCode = undefined;
    this.version = undefined;
    this.sessions = new Map();
    this.lastTabId = undefined;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.config.port}`;
  }

  // -- lifecycle -----------------------------------------------------------

  async probe() {
    try {
      const response = await fetch(`${this.baseUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return undefined;
      const body = await response.json();
      return typeof body?.webSocketDebuggerUrl === 'string' ? body : undefined;
    } catch {
      return undefined;
    }
  }

  async ensureRunning() {
    const existing = await this.probe();
    if (existing !== undefined) {
      this.version = existing;
      return existing;
    }
    if (this.child === undefined || this.child.exitCode !== null) this.launch();
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(300);
      const version = await this.probe();
      if (version !== undefined) {
        this.version = version;
        return version;
      }
      if (this.exitCode !== undefined) {
        throw new Error(
          `the browser exited immediately (code ${this.exitCode}). Another Edge instance may already be using ${this.config.userDataDir}, or the debug port ${this.config.port} is taken. Close that instance or change "userDataDir"/"port" in the plugin config.`,
        );
      }
    }
    throw new Error(
      `the browser did not expose a DevTools port on 127.0.0.1:${this.config.port} within ${LAUNCH_TIMEOUT_MS / 1000}s`,
    );
  }

  launch() {
    const executable = findBrowserExecutable(this.config.browserPath);
    fs.mkdirSync(this.config.userDataDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.config.port}`,
      `--user-data-dir=${this.config.userDataDir}`,
      `--window-size=${this.config.windowSize}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-features=Translate,msEdgeSidebarV2',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ];
    if (this.config.headless) args.push('--headless=new');
    args.push('about:blank');
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {
      this.exitCode = -1;
    });
    child.on('exit', (code) => {
      this.exitCode = code ?? -1;
    });
    child.unref();
    this.child = child;
    this.exitCode = undefined;
    return child.pid;
  }

  // -- targets -------------------------------------------------------------

  async listTargets() {
    const response = await fetch(`${this.baseUrl}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`could not list tabs: HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error('unexpected response from the browser (/json/list)');
    return body.filter((target) => target?.type === 'page');
  }

  async createTarget(url) {
    const endpoint = `${this.baseUrl}/json/new?${encodeURIComponent(url)}`;
    let response = await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) response = await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`could not open a new tab: HTTP ${response.status}`);
    return response.json();
  }

  async pickTarget(tabId) {
    let targets = await this.listTargets();
    if (targets.length === 0) {
      await this.createTarget('about:blank');
      await sleep(300);
      targets = await this.listTargets();
    }
    if (tabId !== undefined && tabId !== null && tabId !== '') {
      const match = targets.find((target) => target.id === tabId);
      if (match === undefined) {
        const known = targets.map((target) => target.id).join(', ');
        throw new Error(`no open tab with id ${tabId} (open tabs: ${known || 'none'})`);
      }
      this.lastTabId = match.id;
      return match;
    }
    const remembered = targets.find((target) => target.id === this.lastTabId);
    if (remembered !== undefined) return remembered;
    const meaningful = targets.find((target) => !/^(about:blank|edge:\/\/|chrome:\/\/)/.test(target.url));
    const chosen = meaningful ?? targets[0];
    this.lastTabId = chosen.id;
    return chosen;
  }

  async session(target) {
    const existing = this.sessions.get(target.id);
    if (existing !== undefined && !existing.closed) return existing;
    if (existing !== undefined) this.sessions.delete(target.id);
    const client = await WebSocketClient.connect(target.webSocketDebuggerUrl, 10_000);
    const session = new Session(client);
    this.sessions.set(target.id, session);
    session.on('Page.loadEventFired', () => {});
    await session.send('Page.enable', {}, 10_000);
    await session.send('Runtime.enable', {}, 10_000).catch(() => {});
    this.lastTabId = target.id;
    return session;
  }

  // -- primitives ----------------------------------------------------------

  async evaluate(session, fn, args = [], options = {}) {
    const expression = `(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(', ')})`;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const response = await session.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: options.awaitPromise === true, userGesture: true },
      timeoutMs,
    );
    if (response.exceptionDetails !== undefined) {
      const details = response.exceptionDetails;
      const message = details.exception?.description ?? details.text ?? 'page script threw';
      throw new Error(`in-page script failed: ${String(message).split('\n')[0]}`);
    }
    return response.result?.value;
  }

  async evaluateExpression(session, expression, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const response = await session.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise === true,
        userGesture: true,
        ...(options.returnByValue === false ? { returnByValue: false } : {}),
      },
      timeoutMs,
    );
    if (response.exceptionDetails !== undefined) {
      const details = response.exceptionDetails;
      const message = details.exception?.description ?? details.text ?? 'expression threw';
      throw new Error(String(message).split('\n')[0]);
    }
    return response.result?.value;
  }

  async waitReady(session, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let state = 'loading';
    while (Date.now() < deadline) {
      state = await this.evaluateExpression(session, 'document.readyState').catch(() => 'loading');
      if (state === 'complete') return 'complete';
      await sleep(150);
    }
    return state;
  }

  async navigate(session, url) {
    const budget = this.config.navigationTimeoutMs;
    let navError = null;
    try {
      const result = await session.send('Page.navigate', { url }, budget);
      if (typeof result?.errorText === 'string' && result.errorText !== '') navError = result.errorText;
    } catch (error) {
      // Chromium delays the Page.navigate response until the navigation commits, so a
      // blocked or unreachable host surfaces as a timeout here instead of an errorText.
      navError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
    const state = await this.waitReady(session, Math.min(budget, 10_000));
    const landing = await this.evaluateExpression(session, 'location.href').catch(() => '');
    if (typeof landing === 'string' && landing.startsWith('chrome-error:')) {
      throw new Error(
        `could not load ${url}: no connection (Chromium error page). The host may be unreachable, blocked by the network, or require a proxy. Use browser_tabs to inspect the tab.`,
      );
    }
    if (navError !== null && state !== 'complete') {
      throw new Error(`could not load ${url}: ${navError}`);
    }
    await sleep(120);
  }

  async snapshot(session, previewChars) {
    return this.evaluate(session, pageSnapshot, [previewChars === undefined ? 800 : previewChars]);
  }

  // -- public operations ---------------------------------------------------

  /**
   * Open a URL, reusing the remembered tab unless `newTab` asks otherwise.
   * @param {{ url: string, tabId?: string, newTab?: boolean }} input
   */
  async open(input) {
    await this.ensureRunning();
    const url = normalizeUrl(input.url);
    if (input.newTab === true) {
      const target = await this.createTarget(url);
      await sleep(500);
      const session = await this.session(target);
      await this.waitReady(session, this.config.navigationTimeoutMs);
      const snapshot = await this.snapshot(session);
      return { tabId: target.id, ...snapshot };
    }
    const target = await this.pickTarget(input.tabId);
    const session = await this.session(target);
    await this.navigate(session, url);
    const snapshot = await this.snapshot(session);
    return { tabId: target.id, ...snapshot };
  }

  /**
   * Read page content, optionally navigating first.
   * @param {{ url?: string, tabId?: string, mode?: string, maxChars?: number, includeLinks?: boolean, includeTables?: boolean, selector?: string }} input
   */
  async read(input) {
    await this.ensureRunning();
    let target;
    let session;
    if (typeof input.url === 'string' && input.url.trim() !== '') {
      target = await this.pickTarget(input.tabId);
      session = await this.session(target);
      await this.navigate(session, normalizeUrl(input.url));
    } else {
      target = await this.pickTarget(input.tabId);
      session = await this.session(target);
    }
    const known = await this.evaluateExpression(session, 'location.href').catch(() => '');
    if (typeof known === 'string' && known.startsWith('chrome-error:')) {
      throw new Error('the tab is showing a Chromium error page: the last navigation failed (no connection).');
    }
    const content = await this.evaluate(session, pageRead, [
      {
        mode: input.mode === 'full' ? 'full' : 'readable',
        maxChars: Number.isInteger(input.maxChars) ? input.maxChars : this.config.maxChars,
        includeLinks: input.includeLinks !== false,
        includeTables: input.includeTables === true,
        selector: typeof input.selector === 'string' ? input.selector : '',
      },
    ]);
    return { tabId: target.id, ...content };
  }

  /**
   * Perform a user gesture on the page.
   * @param {Record<string, unknown>} input
   */
  async act(input) {
    await this.ensureRunning();
    const action = String(input.action ?? '');
    const target = await this.pickTarget(input.tabId);
    const session = await this.session(target);
    const beforeUrl = await this.evaluateExpression(session, 'location.href');
    const notes = [];

    if (action === 'click') {
      const result = await this.evaluate(session, pageClickTarget, [
        typeof input.selector === 'string' ? input.selector : '',
        typeof input.text === 'string' ? input.text : '',
      ]);
      if (result?.ok !== true) throw new Error(`could not click: ${result?.reason ?? 'unknown reason'}`);
      notes.push(`clicked <${String(result.tag).toLowerCase()}>${result.text ? ` "${result.text}"` : ''}`);
      if (result.method === 'pointer') {
        const x = result.x;
        const y = result.y;
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
    } else if (action === 'type') {
      if (typeof input.text !== 'string') throw new Error('browser_act "type" needs a "text" string');
      if (typeof input.selector === 'string' && input.selector !== '') {
        const focus = await this.evaluate(session, pageFocus, [input.selector]);
        if (focus?.ok !== true) throw new Error(`could not focus ${input.selector}: ${focus?.reason ?? 'unknown reason'}`);
      }
      const replace = input.replace === true;
      if (replace) {
        await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await sleep(60);
        await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        await sleep(60);
      }
      await session.send('Input.insertText', { text: input.text });
      notes.push(`typed ${input.text.length} characters`);
      if (input.submit === true) {
        const enter = KEY_CODES.Enter;
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: enter.key,
          code: enter.code,
          windowsVirtualKeyCode: enter.keyCode,
          nativeVirtualKeyCode: enter.keyCode,
          text: enter.text,
        });
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: enter.key,
          code: enter.code,
          windowsVirtualKeyCode: enter.keyCode,
          nativeVirtualKeyCode: enter.keyCode,
        });
        notes.push('pressed Enter');
      }
    } else if (action === 'press') {
      const key = typeof input.key === 'string' && input.key !== '' ? input.key : 'Enter';
      const mapped = KEY_CODES[key];
      if (mapped === undefined) throw new Error(`unsupported key "${key}"; supported: ${Object.keys(KEY_CODES).join(', ')}`);
      const base = { key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode };
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(mapped.text === undefined ? {} : { text: mapped.text }) });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      notes.push(`pressed ${key}`);
    } else if (action === 'scroll') {
      const dy = Number.isFinite(Number(input.dy)) ? Number(input.dy) : 600;
      const dx = Number.isFinite(Number(input.dx)) ? Number(input.dx) : 0;
      const position = await this.evaluate(session, pageScrollBy, [dx, dy]);
      notes.push(`scrolled to y=${position.scrollY} of ${position.scrollHeight}`);
    } else if (action === 'select') {
      if (typeof input.selector !== 'string' || input.selector === '') throw new Error('browser_act "select" needs a "selector"');
      if (input.value === undefined) throw new Error('browser_act "select" needs a "value"');
      const result = await this.evaluate(session, pageSetValue, [input.selector, String(input.value)]);
      if (result?.ok !== true) throw new Error(`could not set ${input.selector}: ${result?.reason ?? 'unknown reason'}`);
      notes.push(`set ${input.selector} to "${result.value}"`);
    } else if (action === 'hover') {
      const result = await this.evaluate(session, pageClickTarget, [
        typeof input.selector === 'string' ? input.selector : '',
        typeof input.text === 'string' ? input.text : '',
      ]);
      if (result?.ok !== true) throw new Error(`could not hover: ${result?.reason ?? 'unknown reason'}`);
      if (result.method === 'pointer') {
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: result.x, y: result.y, button: 'none' });
      }
      notes.push('hovered');
    } else {
      throw new Error(`unknown action "${action}"; expected click, type, press, scroll, select or hover`);
    }

    await sleep(350);
    const afterUrl = await this.evaluateExpression(session, 'location.href').catch(() => beforeUrl);
    if (afterUrl !== beforeUrl) {
      await this.waitReady(session, this.config.navigationTimeoutMs).catch(() => {});
      notes.push(`navigated to ${afterUrl}`);
    }
    const snapshot = await this.snapshot(session, 600);
    return { tabId: target.id, action, ok: true, message: notes.join('; '), ...snapshot };
  }

  /** Run JavaScript in the page. */
  async runScript(input) {
    await this.ensureRunning();
    const target = await this.pickTarget(input.tabId);
    const session = await this.session(target);
    const value = await this.evaluateExpression(session, String(input.expression ?? ''), {
      awaitPromise: input.awaitPromise === true,
      timeoutMs: input.timeoutMs ?? 30_000,
    });
    const page = await this.snapshot(session, 0);
    return { tabId: target.id, value: value === undefined ? null : value, url: page.url, title: page.title };
  }

  /** Capture a PNG of the tab. */
  async screenshot(input) {
    await this.ensureRunning();
    const target = await this.pickTarget(input.tabId);
    const session = await this.session(target);
    const fullPage = input.fullPage === true;
    const capture = await session.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: fullPage },
      60_000,
    );
    const data = capture?.data;
    if (typeof data !== 'string' || data === '') throw new Error('the browser returned an empty screenshot');
    const directory = this.config.outputDir;
    fs.mkdirSync(directory, { recursive: true });
    const requested = typeof input.path === 'string' && input.path !== '' ? input.path : undefined;
    const targetPath =
      requested === undefined
        ? path.join(directory, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
        : path.isAbsolute(requested)
          ? requested
          : path.join(directory, requested);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const bytes = Buffer.from(data, 'base64');
    fs.writeFileSync(targetPath, bytes);
    // Read the real pixel size out of the PNG IHDR chunk: the page is captured at
    // the device pixel ratio, so CSS pixels understate the image.
    const isPng = bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47;
    const width = isPng ? bytes.readUInt32BE(16) : 0;
    const height = isPng ? bytes.readUInt32BE(20) : 0;
    const page = await this.snapshot(session, 0);
    return {
      tabId: target.id,
      path: targetPath,
      bytes: bytes.length,
      width,
      height,
      fullPage,
      url: page.url,
      title: page.title,
    };
  }

  /** Poll for a selector or a text fragment. */
  async waitFor(input) {
    await this.ensureRunning();
    const target = await this.pickTarget(input.tabId);
    const session = await this.session(target);
    const timeoutMs = Number.isInteger(input.timeoutMs) ? input.timeoutMs : 10_000;
    const wantGone = input.state === 'hidden';
    const selector = typeof input.selector === 'string' ? input.selector : '';
    const text = typeof input.text === 'string' ? input.text : '';
    if (selector === '' && text === '') throw new Error('browser_wait needs a "selector" or a "text" to look for');
    const deadline = Date.now() + timeoutMs;
    let found = false;
    while (Date.now() < deadline) {
      found = (await this.evaluate(session, pageProbe, [selector, text]).catch(() => false)) === true;
      if (found !== wantGone) break;
      await sleep(250);
    }
    const satisfied = found !== wantGone;
    const page = await this.snapshot(session, 400);
    return {
      tabId: target.id,
      satisfied,
      timedOut: !satisfied,
      waitedMs: timeoutMs - Math.max(0, deadline - Date.now()),
      selector,
      text,
      state: wantGone ? 'hidden' : 'visible',
      url: page.url,
      title: page.title,
      preview: page.preview,
    };
  }

  /** Describe the running browser and its tabs. */
  async tabs() {
    const version = await this.ensureRunning();
    const targets = await this.listTargets();
    const tabs = targets.map((target) => ({
      tabId: target.id,
      url: target.url,
      title: target.title,
      active: target.id === this.lastTabId,
    }));
    return {
      running: true,
      port: this.config.port,
      browser: String(version?.Browser ?? 'unknown'),
      userDataDir: this.config.userDataDir,
      headless: this.config.headless,
      tabs,
    };
  }

  /** Shut the browser down. */
  async close() {
    const version = await this.probe();
    if (version !== undefined && typeof version.webSocketDebuggerUrl === 'string') {
      try {
        const client = await WebSocketClient.connect(version.webSocketDebuggerUrl, 5000);
        const session = new Session(client);
        await session.send('Browser.close', {}, 5000).catch(() => {});
        session.close();
      } catch {}
    }
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    if (this.child !== undefined) {
      try {
        this.child.kill();
      } catch {}
      this.child = undefined;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await this.probe()) === undefined) break;
      await sleep(250);
    }
    const stillRunning = (await this.probe()) !== undefined;
    return { closed: !stillRunning, forced: stillRunning };
  }

  /** Drop connections without touching the browser process. */
  dispose() {
    for (const session of this.sessions.values()) {
      try {
        session.close();
      } catch {}
    }
    this.sessions.clear();
  }
}
