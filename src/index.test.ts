/**
 * Smoke tests on the pure helpers — the bits with real logic. The
 * client class itself is a network façade; integration testing it
 * properly needs a fake server-worker + fake fetch, which is too much
 * apparatus for v1. Keep these focused on correctness of the parts
 * that would silently break.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  escapeHtml, safeColor, urlBase64ToUint8Array, ReachBell, resolvePromptPlacement, promptCapAllows,
  promptFrequencyAllows, widgetEnabled, safeUrl, safeBackground, normalizeApiUrl, scrollProgress, sameApplicationServerKey,
} from './index';

describe('escapeHtml', () => {
  it('escapes all 5 dangerous HTML chars', () => {
    expect(escapeHtml(`<script>alert("xss")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });
  it('escapes apostrophes (attribute-context safety)', () => {
    expect(escapeHtml(`it's a "test"`)).toBe('it&#39;s a &quot;test&quot;');
  });
  it('leaves safe text untouched', () => {
    expect(escapeHtml('Hello world — नमस्ते')).toBe('Hello world — नमस्ते');
  });
});

describe('safeColor', () => {
  it('accepts hex colours of all 4 valid lengths', () => {
    expect(safeColor('#abc',      '#fff')).toBe('#abc');
    expect(safeColor('#abcd',     '#fff')).toBe('#abcd');
    expect(safeColor('#aabbcc',   '#fff')).toBe('#aabbcc');
    expect(safeColor('#aabbccdd', '#fff')).toBe('#aabbccdd');
  });
  it('accepts well-formed rgb/rgba/hsl/hsla', () => {
    expect(safeColor('rgb(255, 0, 0)',        '#fff')).toBe('rgb(255, 0, 0)');
    expect(safeColor('rgba(0, 0, 0, 0.5)',    '#fff')).toBe('rgba(0, 0, 0, 0.5)');
    expect(safeColor('hsl(120, 100%, 50%)',   '#fff')).toBe('hsl(120, 100%, 50%)');
    expect(safeColor('hsla(0, 0%, 0%, 0.5)',  '#fff')).toBe('hsla(0, 0%, 0%, 0.5)');
  });
  it('rejects style-attribute escapes', () => {
    expect(safeColor('red; opacity: 0',                                '#fff')).toBe('#fff');
    expect(safeColor('red"; pointer-events:auto; "',                   '#fff')).toBe('#fff');
    expect(safeColor('javascript:alert(1)',                            '#fff')).toBe('#fff');
    expect(safeColor('url("javascript:alert(1)")',                     '#fff')).toBe('#fff');
    expect(safeColor('expression(alert(1))',                           '#fff')).toBe('#fff');
  });
  it('rejects non-string input', () => {
    expect(safeColor(undefined, '#fff')).toBe('#fff');
    expect(safeColor(null,      '#fff')).toBe('#fff');
    expect(safeColor(0xff0000,  '#fff')).toBe('#fff');
    expect(safeColor({},        '#fff')).toBe('#fff');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('returns a Uint8Array backed by a real ArrayBuffer', () => {
    const arr = urlBase64ToUint8Array('AQIDBA');
    expect(arr).toBeInstanceOf(Uint8Array);
    expect(arr.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(arr)).toEqual([1, 2, 3, 4]);
  });
  it('decodes URL-safe base64 (- and _ in place of + and /)', () => {
    // 0xfb 0xff 0xbf decodes to standard '+/+/' but URL-safe '-_-_'
    const arr = urlBase64ToUint8Array('-_-_');
    expect(Array.from(arr)).toEqual([0xfb, 0xff, 0xbf]);
  });
  it('handles missing padding', () => {
    expect(Array.from(urlBase64ToUint8Array('AA')))   .toEqual([0x00]);       // '=='
    expect(Array.from(urlBase64ToUint8Array('AAA')))  .toEqual([0x00, 0x00]); // '='
    expect(Array.from(urlBase64ToUint8Array('AAAA'))) .toEqual([0x00, 0x00, 0x00]);
  });
});

describe('ReachBell.init idempotency', () => {
  beforeEach(() => {
    (ReachBell as any).config = null;
    (ReachBell as any).bootstrapping = null;
    (ReachBell as any).warned = false;
    (ReachBell as any).token = null;
  });

  it('is a no-op when called twice without force', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ promptConfig: null, vapidKeys: { public: '' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    ReachBell.init({ apiKey: 'k1', apiUrl: 'https://x.test' });
    ReachBell.init({ apiKey: 'k2', apiUrl: 'https://y.test' });
    expect((ReachBell as any).config.apiKey).toBe('k1');
    expect((ReachBell as any).config.apiUrl).toBe('https://x.test');
    fetchSpy.mockRestore();
  });

  it('replaces config when force:true', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ promptConfig: null, vapidKeys: { public: '' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    ReachBell.init({ apiKey: 'k1', apiUrl: 'https://x.test' });
    ReachBell.init({ apiKey: 'k2', apiUrl: 'https://y.test', force: true });
    expect((ReachBell as any).config.apiKey).toBe('k2');
    fetchSpy.mockRestore();
  });
});

describe('readToken — Safari private mode fallback', () => {
  beforeEach(() => {
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
    try { localStorage.removeItem('reachbell_token'); } catch { /* ignore */ }
  });

  it('returns null when no subscription exists in either tier', () => {
    expect((ReachBell as any).readToken()).toBeNull();
  });

  it('falls back to in-memory token when localStorage throws', () => {
    (ReachBell as any).token = 't_in_memory';
    // Simulate Safari private mode: getItem throws.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    expect((ReachBell as any).readToken()).toBe('t_in_memory');
    spy.mockRestore();
  });

  it('hydrates in-memory token from localStorage on first read', () => {
    localStorage.setItem('reachbell_token', 't_persisted');
    expect((ReachBell as any).token).toBeNull();
    expect((ReachBell as any).readToken()).toBe('t_persisted');
    // Second read: served from memory; mirror is populated.
    expect((ReachBell as any).token).toBe('t_persisted');
  });
});

describe('request — caller-provided signal is honoured', () => {
  beforeEach(() => {
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
  });

  it('aborts when the caller-supplied signal aborts before the timeout fires', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new DOMException('Aborted', 'AbortError');
            reject(err);
          });
        }),
    );
    const outer = new AbortController();
    const promise = (ReachBell as any).request('/anything', { signal: outer.signal }, 30_000);
    outer.abort();
    await expect(promise).rejects.toThrow();
    expect((await promise.catch((e: any) => e)).name).toBe('AbortError');
    fetchSpy.mockRestore();
  });
});

describe('resolvePromptPlacement', () => {
  it('keeps every known placement', () => {
    for (const p of ['center-modal', 'top-bar', 'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']) {
      expect(resolvePromptPlacement(p)).toBe(p);
    }
  });
  it('normalises dashboard spellings', () => {
    expect(resolvePromptPlacement('center_modal')).toBe('center-modal');
    expect(resolvePromptPlacement('Center Modal')).toBe('center-modal');
    expect(resolvePromptPlacement('BOTTOM_RIGHT')).toBe('bottom-right');
    expect(resolvePromptPlacement('banner')).toBe('top-bar');
    expect(resolvePromptPlacement('center')).toBe('center-modal');
    expect(resolvePromptPlacement('top')).toBe('top-center');
  });
  it('falls back to bottom-center for anything unknown', () => {
    expect(resolvePromptPlacement('sideways')).toBe('bottom-center');
    expect(resolvePromptPlacement('')).toBe('bottom-center');
    expect(resolvePromptPlacement(undefined)).toBe('bottom-center');
    expect(resolvePromptPlacement(42)).toBe('bottom-center');
  });
});

describe('promptCapAllows', () => {
  const day = 86_400_000;
  const now = 100 * day;
  it('allows when no cap is configured', () => {
    expect(promptCapAllows([now, now, now, now], now)).toBe(true);
    expect(promptCapAllows([now], now, { maxShows: 0, periodDays: 7 })).toBe(true);
  });
  it('blocks once maxShows is reached inside the period', () => {
    const cap = { maxShows: 3, periodDays: 7 };
    expect(promptCapAllows([now - day, now - 2 * day], now, cap)).toBe(true);
    expect(promptCapAllows([now - day, now - 2 * day, now - 3 * day], now, cap)).toBe(false);
  });
  it('ignores shows older than the period', () => {
    expect(promptCapAllows([now - 8 * day, now - 9 * day, now - 10 * day], now, { maxShows: 3, periodDays: 7 })).toBe(true);
  });
  it('counts every show when no period is set', () => {
    expect(promptCapAllows([1, 2], now, { maxShows: 2 })).toBe(false);
  });
});

describe('showCustomPrompt placement', () => {
  const show = (cfg: Record<string, unknown>) => {
    void (ReachBell as any).showCustomPrompt({ enabled: true, type: 'soft_prompt', ...cfg });
    return document.getElementById('reachbell-custom-prompt') as HTMLElement;
  };

  beforeEach(() => {
    document.getElementById('reachbell-custom-prompt')?.remove();
  });

  it('centres the dashboard center-modal on screen', () => {
    const root = show({ position: 'center-modal' });
    expect(root.style.inset).toBe('0');
    expect(root.style.display).toBe('flex');
    expect(root.style.alignItems).toBe('center');
  });

  it('uses the overlay colour and drops the backdrop when disabled', () => {
    expect(show({ position: 'center-modal', overlayColor: 'rgba(0, 0, 0, 0.5)' }).style.background).toContain('rgba(0, 0, 0, 0.5)');
    const bare = show({ position: 'center-modal', softPrompt: { overlayEnabled: false } });
    expect(bare.style.pointerEvents).toBe('none');
  });

  it('always anchors corner and edge prompts to the viewport', () => {
    for (const position of ['bottom-right', 'top-left', 'bottom-center', 'sideways', '']) {
      const root = show({ position });
      expect(Boolean(root.style.top) || Boolean(root.style.bottom)).toBe(true);
      expect(Boolean(root.style.left) || Boolean(root.style.right)).toBe(true);
    }
  });
});

describe('promptFrequencyAllows', () => {
  const day = 86_400_000;
  const now = 100 * day;
  const fresh = { sessionShows: 0, lastShownAt: null, shownAt: [] };

  it('reads the dashboard frequency setting before frequencyCap', () => {
    const cfg = { frequency: { maxPerSession: 1, cooldownDays: 0 }, frequencyCap: { maxShows: 99, periodDays: 1 } };
    expect(promptFrequencyAllows(fresh, now, cfg)).toBe(true);
    expect(promptFrequencyAllows({ sessionShows: 1, lastShownAt: now, shownAt: [now] }, now, cfg)).toBe(false);
  });

  it('waits out the cooldown before a new session shows again', () => {
    const cfg = { frequency: { maxPerSession: 2, cooldownDays: 7 } };
    expect(promptFrequencyAllows({ sessionShows: 0, lastShownAt: now - 3 * day, shownAt: [now - 3 * day] }, now, cfg)).toBe(false);
    expect(promptFrequencyAllows({ sessionShows: 0, lastShownAt: now - 8 * day, shownAt: [now - 8 * day] }, now, cfg)).toBe(true);
    expect(promptFrequencyAllows({ sessionShows: 1, lastShownAt: now - day, shownAt: [now - day] }, now, cfg)).toBe(true);
  });

  it('falls back to frequencyCap when frequency is absent', () => {
    expect(promptFrequencyAllows({ sessionShows: 0, lastShownAt: now, shownAt: [now, now] }, now, { frequencyCap: { maxShows: 2, periodDays: 7 } })).toBe(false);
    expect(promptFrequencyAllows(fresh, now, null)).toBe(true);
  });
});

describe('widgetEnabled', () => {
  it('only mounts widgets that are explicitly enabled', () => {
    expect(widgetEnabled({})).toBe(false);
    expect(widgetEnabled({ enabled: 'true' })).toBe(false);
    expect(widgetEnabled(null)).toBe(false);
    expect(widgetEnabled({ enabled: true })).toBe(true);
  });
});

describe('safeUrl', () => {
  it('keeps http, https and relative links', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('/orders/1')).toMatch(/\/orders\/1$/);
  });
  it('rejects script and data URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl(' JavaScript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl('')).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });
});

describe('safeBackground', () => {
  it('accepts colours and plain gradients', () => {
    expect(safeBackground('#123456', '#fff')).toBe('#123456');
    expect(safeBackground('linear-gradient(135deg, #111 0%, #222 100%)', '#fff')).toBe('linear-gradient(135deg, #111 0%, #222 100%)');
  });
  it('rejects anything that could load a resource or add rules', () => {
    expect(safeBackground('url(https://evil.test/x.png)', '#fff')).toBe('#fff');
    expect(safeBackground('linear-gradient(red, blue); color: red', '#fff')).toBe('#fff');
  });
});

describe('normalizeApiUrl and scrollProgress', () => {
  it('drops trailing slashes from the API URL', () => {
    expect(normalizeApiUrl('https://api.test///')).toBe('https://api.test');
  });
  it('reports scroll depth as a percentage', () => {
    expect(scrollProgress(0, 2000, 1000)).toBe(0);
    expect(scrollProgress(500, 2000, 1000)).toBe(50);
    expect(scrollProgress(0, 800, 1000)).toBe(100);
  });
});

describe('sameApplicationServerKey', () => {
  const key = 'BAECAwQ';
  it('matches the same key and spots a rotated one', () => {
    expect(sameApplicationServerKey(urlBase64ToUint8Array(key).buffer, key)).toBe(true);
    expect(sameApplicationServerKey(new Uint8Array([9, 9, 9, 9, 9]).buffer, key)).toBe(false);
  });
  it('treats an unknown key as a match so it never churns subscriptions', () => {
    expect(sameApplicationServerKey(null, key)).toBe(true);
  });
});

describe('in-page widgets', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).cleanups = {};
  });

  it('never shows demo widgets from empty saved layouts', () => {
    (ReachBell as any).mountLayouts({ banner: {}, toast: {}, notificationCenter: {} });
    expect(document.querySelector('[id^="reachbell-banner"]')).toBeNull();
    expect(document.getElementById('reachbell-notification-center')).toBeNull();
  });

  it('skips a banner or toast that has no text', () => {
    expect(ReachBell.showBanner({ title: '' })).toBeTypeOf('function');
    expect(document.querySelector('[id^="reachbell-banner"]')).toBeNull();
    ReachBell.showToast({ title: '' });
    expect(document.querySelector('[id^="reachbell-toast-layer"]')).toBeNull();
  });

  it('keeps toast cards clickable without an injected style sheet', () => {
    ReachBell.showToast({ title: 'Hi', duration: 0 });
    const layer = document.querySelector('[id^="reachbell-toast-layer"]') as HTMLElement;
    expect(layer.querySelector('style')).toBeNull();
    expect((layer.firstElementChild as HTMLElement).style.pointerEvents).toBe('auto');
  });

  it('does not seed a welcome item into the notification center', () => {
    localStorage.removeItem('reachbell_notif_history');
    ReachBell.showNotificationCenter();
    expect(ReachBell.getNotificationHistory()).toHaveLength(0);
  });

  it('moves the bell widget clear of a notification center in the same corner', () => {
    ReachBell.showNotificationCenter({ position: 'bottom-right' });
    ReachBell.showBellWidget({ position: 'bottom-right' });
    expect((document.getElementById('reachbell-bell-widget') as HTMLElement).style.bottom).toBe('76px');
  });

  it('removes old listeners when the notification center is re-rendered', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    ReachBell.showNotificationCenter();
    ReachBell.showNotificationCenter();
    expect(remove).toHaveBeenCalledWith('click', expect.any(Function));
    expect(document.querySelectorAll('#reachbell-notification-center')).toHaveLength(1);
    remove.mockRestore();
  });
});

describe('showCustomPrompt behaviour', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (ReachBell as any).closeActivePrompt = null;
  });

  it('settles the earlier prompt when a new one replaces it', async () => {
    const first = (ReachBell as any).showCustomPrompt({ enabled: true, type: 'soft_prompt' });
    void (ReachBell as any).showCustomPrompt({ enabled: true, type: 'soft_prompt' });
    await expect(first).resolves.toBe(false);
    expect(document.querySelectorAll('#reachbell-custom-prompt')).toHaveLength(1);
  });

  it('is a labelled dialog that Escape dismisses', async () => {
    const result = (ReachBell as any).showCustomPrompt({ enabled: true, type: 'soft_prompt', position: 'center-modal', title: 'Hello' });
    const root = document.getElementById('reachbell-custom-prompt') as HTMLElement;
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(root.getAttribute('aria-labelledby') as string)?.textContent).toBe('Hello');
    expect(document.activeElement?.getAttribute('data-action')).toBe('accept');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(result).resolves.toBe(false);
    expect(document.getElementById('reachbell-custom-prompt')).toBeNull();
  });

  it('renders top-bar text as text, not markup', () => {
    void (ReachBell as any).showCustomPrompt({ enabled: true, type: 'soft_prompt', position: 'top-bar', title: 'T', body: '<b>x</b>' });
    const root = document.getElementById('reachbell-custom-prompt') as HTMLElement;
    const title = document.getElementById('reachbell-custom-prompt-title') as HTMLElement;
    expect(title.nextElementSibling?.textContent).toBe(': <b>x</b>');
    expect(root.querySelector('b')).toBeNull();
  });
});

describe('prompt guards', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).bootstrapping = null;
    (ReachBell as any).prompting = null;
    (ReachBell as any).serverContext = null;
    (window as any).PushManager = function PushManager() {};
  });

  it('does not ask for permission when settings cannot be loaded', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    const ask = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: ask });
    await expect(ReachBell.prompt()).resolves.toEqual({ success: false, reason: 'not_ready' });
    expect(ask).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('returns permission_denied without showing anything once blocked', async () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() });
    await expect(ReachBell.prompt()).resolves.toEqual({ success: false, reason: 'permission_denied' });
    expect(document.getElementById('reachbell-custom-prompt')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('token storage', () => {
  beforeEach(() => {
    (ReachBell as any).config = { apiKey: 'project_a', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
    localStorage.clear();
  });

  it('keys the token by project', () => {
    (ReachBell as any).storeToken('t_a', 'https://push.test/1');
    expect(localStorage.getItem('reachbell_token:project_a')).toBe('t_a');
    (ReachBell as any).config = { apiKey: 'project_b', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
    expect((ReachBell as any).readToken()).toBeNull();
  });
});
