/**
 * DSH host plugin: Microsoft Edge automation tools.
 *
 * Exposes eight model-facing tools that share one lazily launched, isolated
 * Edge instance driven over the DevTools Protocol: open a page, read its
 * content, act on it (click / type / press / scroll / select / hover), run
 * JavaScript, screenshot it, wait for a condition, list tabs, and shut down.
 */
import { EdgeBrowser } from './lib/browser.js';

/** @type {import('@deepseek-ai/cordis').Context} */
export const inject = ['tools'];

/** Build the {type:'text'} content block the tool renderer returns. */
function text(value) {
  return [{ type: 'text', text: String(value) }];
}

/** Truncate a JSON-ish value for display. */
function describe(value, limit = 8000) {
  let rendered;
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    rendered = String(value);
  }
  if (rendered === undefined) return 'undefined';
  return rendered.length > limit ? `${rendered.slice(0, limit)}\n…[${rendered.length - limit} more chars]` : rendered;
}

const TAB_ID = {
  type: 'string',
  description: 'Tab id from browser_tabs. Omit to use the most recently used tab.',
};

/**
 * Convert the authoring shorthand used below (per-property `required: true`)
 * into standard JSON Schema (`required: [...]` on the parent), which is what
 * the host's schema validator accepts.
 */
function normalizeSchema(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(normalizeSchema);
  const result = {};
  const required = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') continue;
    if (key === 'properties' && value !== null && typeof value === 'object') {
      const properties = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        if (propertySchema !== null && typeof propertySchema === 'object' && propertySchema.required === true) required.push(propertyName);
        properties[propertyName] = normalizeSchema(propertySchema);
      }
      result.properties = properties;
      continue;
    }
    result[key] = key === 'items' ? normalizeSchema(value) : value;
  }
  if (required.length > 0) result.required = required;
  return result;
}

/** Declare a tool output: schema plus the renderer that turns a value into text. */
function outputSchema(schema, render) {
  return { schema: normalizeSchema(schema), render };
}

/**
 * Register every browser tool on the host tool registry.
 * @param {any} ctx
 * @param {EdgeBrowser} browser
 * @returns {() => void}
 */
function registerTools(ctx, browser) {
  const disposers = [];

  disposers.push(
    ctx.tools.register({
      name: 'browser_open',
      description:
        'Open a URL in the automation Edge browser and return its title plus a text preview. The browser launches automatically on first use (a few seconds) with an isolated profile, so no existing Edge window is touched and the user is not logged in there. Relative URLs are not accepted; a bare host such as "example.com" is upgraded to https://. Use browser_read afterwards for the full content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL, or a bare host to open over https.' },
          tabId: TAB_ID,
          newTab: { type: 'boolean', description: 'Open in a fresh tab instead of reusing the current one.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      output: outputSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: { type: 'string', required: true, description: 'Tab id for later calls.' },
            url: { type: 'string', required: true, description: 'Final URL after redirects.' },
            title: { type: 'string', required: true, description: 'Document title.' },
            readyState: { type: 'string', required: true, description: 'document.readyState at capture time.' },
            preview: { type: 'string', required: true, description: 'Short plain-text preview of the page.' },
            charCount: { type: 'number', required: true, description: 'Characters of body text on the page.' },
          },
        },
        (_args, value) => text(`Opened ${value.url}\nTitle: ${value.title}\nTab: ${value.tabId}\n\n${value.preview}`),
      ),
      isConcurrencySafe: () => false,
      timeoutMs: 120_000,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        return browser.open({
          url: args.url,
          tabId: typeof args.tabId === 'string' ? args.tabId : undefined,
          newTab: args.newTab === true,
        });
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'browser_read',
      description:
        'Read the visible content of a page in the automation Edge browser: cleaned body text, headings, links and (optionally) tables. Pass "url" to navigate first, or omit it to read the current tab. Prefer this over web_fetch whenever the page is rendered by JavaScript, sits behind a login, or must be inspected after interacting with it. "readable" mode strips navigation/forms/footers and prefers main/article content; "full" mode returns the whole body text. Output is capped by maxChars (default 20000).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Navigate to this URL before reading. Omit to read the current tab.' },
          tabId: TAB_ID,
          mode: {
            type: 'string',
            enum: ['readable', 'full'],
            description: 'readable (default): main content only; full: entire body text.',
          },
          maxChars: { type: 'number', description: 'Maximum characters of text to return (default 20000).' },
          selector: { type: 'string', description: 'CSS selector to scope the readable extraction to one container.' },
          includeLinks: { type: 'boolean', description: 'Include page links (default true).' },
          includeTables: { type: 'boolean', description: 'Include the first tables as row arrays (default false).' },
        },
        additionalProperties: false,
      },
      output: outputSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: { type: 'string', required: true },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            lang: { type: 'string', required: true },
            description: { type: 'string', required: true },
            readyState: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            text: { type: 'string', required: true },
            charCount: { type: 'number', required: true },
            truncated: { type: 'boolean', required: true },
            headings: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { level: { type: 'number', required: true }, text: { type: 'string', required: true } },
              },
            },
            links: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { text: { type: 'string', required: true }, href: { type: 'string', required: true } },
              },
            },
            tables: {
              type: 'array',
              required: true,
              items: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
        (_args, value) => {
          const header = `# ${value.title}\n${value.url}`;
          const meta = `${value.charCount} chars${value.truncated ? ' (truncated)' : ''} · ${value.headings.length} headings · ${value.links.length} links${value.tables.length > 0 ? ` · ${value.tables.length} tables` : ''}`;
          const headings = value.headings.length > 0 ? `\n\nHeadings:\n${value.headings.map((heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}- ${heading.text}`).join('\n')}` : '';
          const links = value.links.length > 0 ? `\n\nLinks:\n${value.links.slice(0, 40).map((link) => `- ${link.text} — ${link.href}`).join('\n')}` : '';
          const tables = value.tables.map((rows, index) => `\n\nTable ${index + 1}:\n${rows.map((row) => row.join(' | ')).join('\n')}`).join('');
          return text(`${header}\n${meta}\n\n${value.text}${headings}${links}${tables}`);
        },
      ),
      isConcurrencySafe: () => false,
      timeoutMs: 180_000,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        return browser.read({
          url: typeof args.url === 'string' ? args.url : undefined,
          tabId: typeof args.tabId === 'string' ? args.tabId : undefined,
          mode: args.mode === 'full' ? 'full' : 'readable',
          maxChars: Number.isInteger(args.maxChars) ? args.maxChars : undefined,
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          includeLinks: args.includeLinks !== false,
          includeTables: args.includeTables === true,
        });
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'browser_act',
      description:
        'Perform a user gesture in the automation Edge browser and return the resulting URL, title and a text preview. Actions: "click" (by CSS selector or by visible text — real pointer events at the element centre, with a DOM-click fallback for hidden elements), "type" (focus a selector, then insert text; set "replace" to clear the field first and "submit" to press Enter), "press" (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space), "scroll" (dy/dx in pixels), "select" (set a form control value and fire input/change), "hover". Wait for the page to settle with browser_wait when the target appears asynchronously.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'type', 'press', 'scroll', 'select', 'hover'],
            description: 'Gesture to perform.',
          },
          selector: { type: 'string', description: 'CSS selector of the target element.' },
          text: {
            type: 'string',
            description: 'For click/hover: visible text of the element when a selector is unknown. For type: the text to insert.',
          },
          key: { type: 'string', description: 'For press: the key name.' },
          value: { type: 'string', description: 'For select: the value to set.' },
          dy: { type: 'number', description: 'For scroll: vertical pixels (positive scrolls down).' },
          dx: { type: 'number', description: 'For scroll: horizontal pixels.' },
          submit: { type: 'boolean', description: 'For type: press Enter afterwards.' },
          replace: { type: 'boolean', description: 'For type: select the field content first so it is replaced.' },
          tabId: TAB_ID,
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: outputSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: { type: 'string', required: true },
            action: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            readyState: { type: 'string', required: true },
            preview: { type: 'string', required: true },
            charCount: { type: 'number', required: true },
          },
        },
        (_args, value) => text(`${value.message}\n→ ${value.url} (${value.title})\n\n${value.preview}`),
      ),
      isConcurrencySafe: () => false,
      timeoutMs: 120_000,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        return browser.act({
          action: args.action,
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
          key: typeof args.key === 'string' ? args.key : undefined,
          value: args.value,
          dy: args.dy,
          dx: args.dx,
          submit: args.submit === true,
          replace: args.replace === true,
          tabId: typeof args.tabId === 'string' ? args.tabId : undefined,
        });
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'browser_eval',
      description:
        'Evaluate a JavaScript expression in the current page of the automation Edge browser and return its JSON-encoded value. The expression runs in the page main world with page privileges; the result must be JSON-serialisable. Use it for structural extraction, computed values, or anything the read/act tools do not cover.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate in the page.' },
          awaitPromise: { type: 'boolean', description: 'Await the result when it is a Promise (default false).' },
          timeoutMs: { type: 'number', description: 'Evaluation timeout in milliseconds (default 30000).' },
          tabId: TAB_ID,
        },
        required: ['expression'],
        additionalProperties: false,
      },
      output: outputSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: { type: 'string', required: true },
            value: { required: true, description: 'JSON value returned by the expression (null when undefined).' },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        (_args, value) => text(`${value.title}\n${value.url}\n\n${describe(value.value)}`),
      ),
      isConcurrencySafe: () => false,
      timeoutMs: 120_000,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        return browser.runScript({
          expression: args.expression,
          awaitPromise: args.awaitPromise === true,
          timeoutMs: Number.isInteger(args.timeoutMs) ? args.timeoutMs : undefined,
          tabId: typeof args.tabId === 'string' ? args.tabId : undefined,
        });
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'browser_screenshot',
      description:
        'Capture a PNG of the current page in the automation Edge browser and return the absolute file path with its size. Useful to show the user what the page looks like or to check rendering before acting. A relative path is resolved against the plugin output directory; without a path a timestamped file is created there.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional output file path (absolute, or relative to the output directory).' },
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport (default false).' },
          tabId: TAB_ID,
        },
        additionalProperties: false,
      },
      output: outputSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: { type: 'string', required: true },
            path: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
            width: { type: 'number', required: true },
            height: { type: 'number', required: true },
            fullPage: { type: 'boolean', required: true },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        (_args, value) =>
          text(`Screenshot saved: ${value.path}\n${value.width}×${value.height}px, ${Math.round(value.bytes / 1024)} KiB${value.fullPage ? ' (full page)' : ''}\n${value.title} — ${value.url}`),
      ),
      isConcurrencySafe: () => false,
      timeoutMs: 120_000,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        return browser.screenshot({
          path: typeof args.path === 'string' ? args.path : undefined,
          fullPage: args.fullPage === true,
          tabId: typeof args.tabId === 'string' ? args.tabId : undefined,
        });
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'browser_wait',
      description:
        'Wait until a CSS selector appears (or disappears) or a text fragment is present in the page, polling the current tab. Use it after browser_open on a JavaScript-heavy page or after browser_act that triggers async loading, instead of guessing with sleeps.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for.' },
          text: { type: 'string', description: 'Wait until the body text contains this fragment.' },
          state: {
            type: 'string',
            enum: ['visible', 'hidden'],
            description: 'visible (default): wait until present; hidden: wait until gone.',
          },
          timeoutMs: { type: 'number', description: 'How long to wait before reporting a timeout (default 10000).' },
          tabId: TAB_ID,
        },
        additionalProperties: false,
      },
      output: outputSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: { type: 'string', required: true },
            satisfied: { type: 'boolean', required: true },
            timedOut: { type: 'boolean', required: true },
            waitedMs: { type: 'number', required: true },
            selector: { type: 'string', required: true },
            text: { type: 'string', required: true },
            state: { type: 'string', required: true },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            preview: { type: 'string', required: true },
          },
        },
        (_args, value) =>
          text(
            `${value.satisfied ? 'Condition met' : 'Timed out'} after ${value.waitedMs}ms for ${value.selector ? `selector ${value.selector}` : `text "${value.text}"`} (${value.state})\n${value.title} — ${value.url}\n\n${value.preview}`,
          ),
      ),
      isConcurrencySafe: () => false,
      timeoutMs: 120_000,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        return browser.waitFor({
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
          state: args.state === 'hidden' ? 'hidden' : 'visible',
          timeoutMs: Number.isInteger(args.timeoutMs) ? args.timeoutMs : undefined,
          tabId: typeof args.tabId === 'string' ? args.tabId : undefined,
        });
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'browser_tabs',
      description:
        'List the automation Edge browser state: whether it is running, its version, the profile directory, and every open tab with its id, URL and title. Use it to discover a tabId for other browser tools.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: outputSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            running: { type: 'boolean', required: true },
            port: { type: 'number', required: true },
            browser: { type: 'string', required: true },
            userDataDir: { type: 'string', required: true },
            headless: { type: 'boolean', required: true },
            tabs: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  tabId: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  active: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        (_args, value) =>
          text(
            `${value.browser} on 127.0.0.1:${value.port} · profile ${value.userDataDir}${value.headless ? ' · headless' : ''}\n${value.tabs.length} tab(s):\n${value.tabs.map((tab) => `- ${tab.active ? '*' : ' '} ${tab.title || '(untitled)'} — ${tab.url}\n  id: ${tab.tabId}`).join('\n')}`,
          ),
      ),
      isConcurrencySafe: () => false,
      timeoutMs: 60_000,
      async execute(_args, exec) {
        exec.signal.throwIfAborted();
        return browser.tabs();
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'browser_close',
      description: 'Shut down the automation Edge browser and every tab it owns. The next browser tool call starts a fresh instance.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: outputSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            closed: { type: 'boolean', required: true },
            forced: { type: 'boolean', required: true },
          },
        },
        (_args, value) => text(value.closed ? 'Closed the automation browser.' : 'The browser is still running; a forced shutdown was requested but did not take effect.'),
      ),
      isConcurrencySafe: () => false,
      timeoutMs: 60_000,
      async execute(_args, exec) {
        exec.signal.throwIfAborted();
        return browser.close();
      },
    }),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
  };
}

/**
 * Plugin entry.
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const browser = new EdgeBrowser(config);
  ctx.effect(() => {
    const disposeTools = registerTools(ctx, browser);
    return () => {
      disposeTools();
      browser.dispose();
    };
  }, 'dsh-edge-browser: browser tools');
}
