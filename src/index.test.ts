/**
 * Smoke tests on the pure helpers — the bits with real logic. The
 * client class itself is a network façade; integration testing it
 * properly needs a fake server-worker + fake fetch, which is too much
 * apparatus for v1. Keep these focused on correctness of the parts
 * that would silently break.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  escapeHtml, safeColor, urlBase64ToUint8Array, ReachBell, resolvePromptPlacement, promptCapAllows,
  promptFrequencyAllows, widgetEnabled, safeUrl, safeBackground, normalizeApiUrl, scrollProgress, sameApplicationServerKey,
  nativePromptNeedsGesture,
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ promptConfig: null, vapidKeys: { public: '' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    ReachBell.init({ apiKey: 'k1', apiUrl: 'https://x.test' });
    const onInit = vi.fn();
    window.addEventListener('reachbell:init', onInit);
    ReachBell.init({ apiKey: 'k2', apiUrl: 'https://y.test', force: true });
    window.removeEventListener('reachbell:init', onInit);
    expect((ReachBell as any).config.apiKey).toBe('k2');
    expect(onInit).toHaveBeenCalledOnce();
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
    const promise = (ReachBell as any).request('/anything', { signal: outer.signal }, (res: Response) => res, 30_000);
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

describe('nativePromptNeedsGesture', () => {
  const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  const EDGE = `${CHROME} Edg/142.0.0.0`;
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
  const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0';
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1';
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';

  it('shows on the timer in Chromium browsers', () => {
    expect(nativePromptNeedsGesture(CHROME)).toBe(false);
    expect(nativePromptNeedsGesture(EDGE)).toBe(false);
    expect(nativePromptNeedsGesture(ANDROID_CHROME)).toBe(false);
    expect(nativePromptNeedsGesture('anything', true)).toBe(false);
  });

  it('waits for a click in Safari, Firefox, iOS and unknown browsers', () => {
    expect(nativePromptNeedsGesture(SAFARI)).toBe(true);
    expect(nativePromptNeedsGesture(FIREFOX)).toBe(true);
    expect(nativePromptNeedsGesture(IOS_CHROME, true)).toBe(true);
    expect(nativePromptNeedsGesture('')).toBe(true);
  });
});

describe('subscription lifecycle', () => {
  beforeEach(() => {
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).swReg = null;
    (ReachBell as any).bootstrapping = null;
  });

  it('unsubscribe() waits for bootstrap before looking up the subscription', async () => {
    const unsub = vi.fn().mockResolvedValue(true);
    let finish!: () => void;
    (ReachBell as any).bootstrapping = new Promise<void>(resolve => {
      finish = () => {
        (ReachBell as any).swReg = { pushManager: { getSubscription: async () => ({ unsubscribe: unsub }) } };
        resolve();
      };
    });
    const result = ReachBell.unsubscribe();
    finish();
    await expect(result).resolves.toEqual({ ok: true });
    expect(unsub).toHaveBeenCalledOnce();
  });

  it('a superseded context load does not overwrite the new project settings', async () => {
    let respond!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(r => { respond = r; }));
    try {
      (ReachBell as any).serverContext = null;
      const load = (ReachBell as any).loadContext();
      (ReachBell as any).config = { apiKey: 'other', apiUrl: 'https://x.test' };
      respond(new Response(JSON.stringify({ promptConfig: { enabled: true } }), { status: 200 }));
      await load;
      expect((ReachBell as any).serverContext).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VAPID = 'BAECAwQ';

/** A fake registration whose push subscription records unsubscribe/subscribe. */
function fakeRegistration(existing: boolean) {
  const sub = {
    endpoint: 'https://push.test/1',
    options: { applicationServerKey: null },
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({ endpoint: 'https://push.test/1' }),
  };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existing ? sub : null),
    subscribe: vi.fn().mockResolvedValue(sub),
  };
  return { reg: { active: {}, pushManager } as any, sub, pushManager };
}

describe('unsubscribe opt-out', () => {
  beforeEach(() => {
    localStorage.clear();
    (ReachBell as any).optedOutMemory.clear();
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test', swPath: '/reachbell-sw.js' };
    (ReachBell as any).bootstrapping = null;
    (ReachBell as any).prompting = null;
    (ReachBell as any).token = null;
    (ReachBell as any).serverContext = { vapidKeys: { public: VAPID } };
    (window as any).PushManager = function PushManager() {};
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (ReachBell as any).swReg = null;
  });

  it('does not silently re-subscribe on the next page load after unsubscribe()', async () => {
    const { reg, sub, pushManager } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).storeToken('t1', sub.endpoint);
    await expect(ReachBell.unsubscribe()).resolves.toEqual({ ok: true });
    expect(sub.unsubscribe).toHaveBeenCalledOnce();

    // Next page load: permission is still granted, no token, no subscription.
    (ReachBell as any).token = null;
    pushManager.getSubscription.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await (ReachBell as any).syncSubscription();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prompt() clears the opt-out and subscribes again', async () => {
    const { reg, pushManager } = fakeRegistration(false);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).setOptedOut(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ token: 't2' }));
    await expect(ReachBell.prompt()).resolves.toEqual({ success: true, token: 't2' });
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
    expect((ReachBell as any).isOptedOut()).toBe(false);
  });

  it('finds the worker registration itself when bootstrap never set one', async () => {
    const { reg, sub } = fakeRegistration(true);
    const getRegistration = vi.fn().mockResolvedValue(reg);
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration } });
    await expect(ReachBell.unsubscribe()).resolves.toEqual({ ok: true });
    expect(getRegistration).toHaveBeenCalledWith('/reachbell-sw.js');
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
  });

  it('reports failure instead of ok:true when no registration exists', async () => {
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined) } });
    await expect(ReachBell.unsubscribe()).resolves.toEqual({ ok: false, reason: 'sw_not_registered' });
  });

  it('still tells a mounted bell widget when no registration exists', async () => {
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined) } });
    const onChange = vi.fn();
    (ReachBell as any).onSubscriptionChange = onChange;
    try {
      await expect(ReachBell.unsubscribe()).resolves.toEqual({ ok: false, reason: 'sw_not_registered' });
      expect(onChange).toHaveBeenCalled();
      expect((ReachBell as any).isSubscribed()).toBe(false);
    } finally {
      (ReachBell as any).onSubscriptionChange = null;
    }
  });

  it('keeps the opt-out for the page session when localStorage is unavailable', async () => {
    const { reg, sub, pushManager } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    (ReachBell as any).token = 't1';
    await expect(ReachBell.unsubscribe()).resolves.toEqual({ ok: true });
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    expect((ReachBell as any).isOptedOut()).toBe(true);

    pushManager.getSubscription.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await (ReachBell as any).syncSubscription();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // prompt() is still the way back in.
    (ReachBell as any).setOptedOut(false);
    expect((ReachBell as any).isOptedOut()).toBe(false);
  });

  it('unsubscribe() clears the stored identity', async () => {
    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).storeIdentity({ externalId: 'u1', hash: 'h1' });
    await ReachBell.unsubscribe();
    expect((ReachBell as any).readIdentity()).toBeNull();
  });
});

describe('attachUtmTagger', () => {
  it('tags outbound web links but leaves javascript:, mailto: and tel: alone', () => {
    (ReachBell as any)._utmHandlerInstalled = false;
    document.body.replaceChildren();
    ReachBell.attachUtmTagger({ source: 'rb', medium: 'push' });
    const links: Record<string, string> = {
      web:  'https://other.test/page',
      js:   'javascript:void(0)',
      mail: 'mailto:hi@other.test',
      tel:  'tel:+15550100',
    };
    const anchors = Object.fromEntries(Object.entries(links).map(([k, href]) => {
      const a = document.createElement('a');
      a.href = href;
      a.addEventListener('click', e => e.preventDefault());
      document.body.appendChild(a);
      return [k, a];
    }));
    for (const a of Object.values(anchors)) a.click();
    expect(anchors.web.href).toContain('utm_source=rb');
    expect(anchors.js.getAttribute('href')).toBe(links.js);
    expect(anchors.mail.getAttribute('href')).toBe(links.mail);
    expect(anchors.tel.getAttribute('href')).toBe(links.tel);
  });
});

describe('identify', () => {
  beforeEach(() => {
    localStorage.clear();
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
  });
  afterEach(() => vi.restoreAllMocks());

  type Spy = { mock: { calls: unknown[][] } };
  const bodyOf = (spy: Spy, call = 0) => JSON.parse((spy.mock.calls[call][1] as RequestInit).body as string);
  const urlOf = (spy: Spy, call = 0) => String(spy.mock.calls[call][0]);

  it('identify(null) unlinks the user via /subscribers/unidentify', async () => {
    (ReachBell as any).storeToken('t1', null);
    (ReachBell as any).storeIdentity({ externalId: 'u1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true }));
    await expect(ReachBell.identify(null)).resolves.toEqual({ ok: true });
    expect(urlOf(fetchSpy)).toBe('https://x.test/subscribers/unidentify');
    expect(bodyOf(fetchSpy)).toEqual({ token: 't1' });
    expect((ReachBell as any).readIdentity()).toBeNull();
  });

  it('identify(null) without a subscription fails without a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(ReachBell.identify(null)).resolves.toEqual({ ok: false, reason: 'no_subscription' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the identity hash and stores it with the externalId', async () => {
    (ReachBell as any).storeToken('t1', null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true }));
    await expect(ReachBell.identify('shopify_customer_7', { hash: 'abc123' })).resolves.toEqual({ ok: true });
    expect(urlOf(fetchSpy)).toBe('https://x.test/subscribers/identify');
    expect(bodyOf(fetchSpy)).toEqual({ token: 't1', externalId: 'shopify_customer_7', identityHash: 'abc123' });
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'shopify_customer_7', hash: 'abc123' });
  });

  it('reports a rejected hash and does not store the identity', async () => {
    (ReachBell as any).storeToken('t1', null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: false, reason: 'identity_hash_invalid' }, 201));
    await expect(ReachBell.identify('shopify_customer_7', { hash: 'bad' })).resolves.toEqual({ ok: false, reason: 'identity_hash_invalid' });
    expect((ReachBell as any).readIdentity()).toBeNull();
  });

  it('resends the stored externalId and hash when registering the subscription', async () => {
    (ReachBell as any).storeIdentity({ externalId: 'shopify_customer_7', hash: 'abc123' });
    const { sub } = fakeRegistration(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ token: 't9' }));
    await expect((ReachBell as any).registerSubscriber(sub, (ReachBell as any).readIdentity())).resolves.toEqual({ success: true, token: 't9' });
    expect(urlOf(fetchSpy)).toBe('https://x.test/subscribers');
    expect(bodyOf(fetchSpy)).toMatchObject({ externalId: 'shopify_customer_7', identityHash: 'abc123', tokenType: 'vapid' });
  });

  it('drops a stale hash and still subscribes when the API rejects it', async () => {
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).serverContext = { vapidKeys: { public: VAPID } };
    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).storeIdentity({ externalId: 'shopify_customer_7', hash: 'old' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ success: false, reason: 'identity_hash_invalid' }, 201))
      .mockResolvedValueOnce(jsonResponse({ token: 't9' }));
    await expect((ReachBell as any).subscribe()).resolves.toEqual({ success: true, token: 't9', identityDropped: true });
    expect(bodyOf(fetchSpy, 1).externalId).toBeUndefined();
    expect((ReachBell as any).readIdentity()).toBeNull();
    (ReachBell as any).swReg = null;
  });
});

describe('force re-init while subscribing', () => {
  beforeEach(() => {
    localStorage.clear();
    (ReachBell as any).config = { apiKey: 'old', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
    (ReachBell as any).serverContext = { vapidKeys: { public: VAPID } };
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (ReachBell as any).swReg = null;
  });

  it('does not register or store a token when re-initialised during pushManager.subscribe', async () => {
    const { reg, sub, pushManager } = fakeRegistration(false);
    (ReachBell as any).swReg = reg;
    let finish!: () => void;
    pushManager.subscribe.mockReturnValue(new Promise(resolve => { finish = () => resolve(sub); }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ token: 't-old' }));
    const sync = (ReachBell as any).syncSubscription();
    await vi.waitFor(() => expect(pushManager.subscribe).toHaveBeenCalled());
    (ReachBell as any).config = { apiKey: 'new', apiUrl: 'https://x.test' };
    finish();
    await sync;
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem('reachbell_token:new')).toBeNull();
    expect(localStorage.getItem('reachbell_token:old')).toBeNull();
  });

  it('does not store the token when re-initialised while POST /subscribers is in flight', async () => {
    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    let respond!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(r => { respond = r; }));
    const result = (ReachBell as any).subscribe();
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'));
    (ReachBell as any).config = { apiKey: 'new', apiUrl: 'https://x.test' };
    respond(jsonResponse({ token: 't-old' }));
    await expect(result).resolves.toEqual({ success: false, reason: 'superseded' });
    expect((ReachBell as any).token).toBeNull();
    expect(localStorage.getItem('reachbell_token:new')).toBeNull();
  });
});

describe('identify — newest user wins', () => {
  beforeEach(() => {
    localStorage.clear();
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
    (ReachBell as any).serverContext = { vapidKeys: { public: VAPID } };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    (ReachBell as any).swReg = null;
  });

  const bodyOf = (spy: { mock: { calls: unknown[][] } }, call = 0) =>
    JSON.parse((spy.mock.calls[call][1] as RequestInit).body as string);

  it('remembers an identify() made before subscribing and sends it on subscribe, replacing an older user', async () => {
    (ReachBell as any).storeIdentity({ externalId: 'old_user', hash: 'old_hash' });
    await expect(ReachBell.identify('new_user', { hash: 'new_hash' })).resolves.toEqual({ ok: false, reason: 'no_subscription' });
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'new_user', hash: 'new_hash', pending: true });

    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ token: 't1' }));
    await expect((ReachBell as any).subscribe()).resolves.toEqual({ success: true, token: 't1' });
    expect(bodyOf(fetchSpy)).toMatchObject({ externalId: 'new_user', identityHash: 'new_hash' });
    // A successful POST /subscribers that carried the identity confirms it.
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'new_user', hash: 'new_hash' });
  });

  it('a rejected hash clears the previous user instead of keeping it', async () => {
    (ReachBell as any).storeToken('t1', null);
    (ReachBell as any).storeIdentity({ externalId: 'old_user' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: false, reason: 'identity_hash_invalid' }, 201));
    await expect(ReachBell.identify('shopify_customer_9', { hash: 'bad' })).resolves.toEqual({ ok: false, reason: 'identity_hash_invalid' });
    expect((ReachBell as any).readIdentity()).toBeNull();
  });

  it('a network failure still stores the new user so it is resent on the next subscribe', async () => {
    (ReachBell as any).storeToken('t1', null);
    (ReachBell as any).storeIdentity({ externalId: 'old_user' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(ReachBell.identify('new_user')).resolves.toEqual({ ok: false, reason: 'network_error' });
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'new_user', pending: true });
  });

  it('flags a successful subscribe that had to drop a stale identity hash', async () => {
    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).storeIdentity({ externalId: 'shopify_customer_7', hash: 'old' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ success: false, reason: 'identity_hash_invalid' }, 201))
      .mockResolvedValueOnce(jsonResponse({ token: 't9' }));
    await expect((ReachBell as any).subscribe()).resolves.toEqual({ success: true, token: 't9', identityDropped: true });
  });
});

describe('unconfirmed identity retry', () => {
  beforeEach(() => {
    localStorage.clear();
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
    (ReachBell as any).identityRetried = false;
    (ReachBell as any).optedOutMemory.clear();
    (ReachBell as any).identityMemory.clear();
    (ReachBell as any).serverContext = { vapidKeys: { public: VAPID } };
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (ReachBell as any).swReg = null;
  });

  const bodyOf = (spy: { mock: { calls: unknown[][] } }, call = 0) =>
    JSON.parse((spy.mock.calls[call][1] as RequestInit).body as string);
  const urlOf = (spy: { mock: { calls: unknown[][] } }, call = 0) => String(spy.mock.calls[call][0]);

  /** A valid (non-stale) subscription: token + endpoint stored, matching sub. */
  function subscribed() {
    const fake = fakeRegistration(true);
    (ReachBell as any).swReg = fake.reg;
    (ReachBell as any).storeToken('t1', fake.sub.endpoint);
    return fake;
  }

  it('re-sends an identify that failed offline once on the next sync and confirms it', async () => {
    subscribed();
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(ReachBell.identify('u2', { hash: 'h2' })).resolves.toEqual({ ok: false, reason: 'network_error' });
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'u2', hash: 'h2', pending: true });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true }));
    fetchSpy.mockClear();
    await (ReachBell as any).syncSubscription();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(urlOf(fetchSpy)).toBe('https://x.test/subscribers/identify');
    expect(bodyOf(fetchSpy)).toEqual({ token: 't1', externalId: 'u2', identityHash: 'h2' });
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'u2', hash: 'h2' });

    // Confirmed: no further requests.
    (ReachBell as any).identityRetried = false;
    await (ReachBell as any).syncSubscription();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('retries at most once per page load while it keeps failing', async () => {
    subscribed();
    (ReachBell as any).storeIdentity({ externalId: 'u2', pending: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 503));
    await (ReachBell as any).syncSubscription();
    await (ReachBell as any).syncSubscription();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'u2', pending: true });
  });

  it('clears the identity and fires reachbell:identity-dropped when the retry hash is rejected', async () => {
    subscribed();
    (ReachBell as any).storeIdentity({ externalId: 'shopify_customer_1', hash: 'old', pending: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: false, reason: 'identity_hash_invalid' }, 201));
    const onDropped = vi.fn();
    window.addEventListener('reachbell:identity-dropped', onDropped);
    try {
      await (ReachBell as any).syncSubscription();
    } finally {
      window.removeEventListener('reachbell:identity-dropped', onDropped);
    }
    expect((ReachBell as any).readIdentity()).toBeNull();
    expect(onDropped).toHaveBeenCalledOnce();
    expect(onDropped.mock.calls[0][0].detail).toEqual({ externalId: 'shopify_customer_1' });
  });

  it('does not retry a confirmed identity', async () => {
    subscribed();
    (ReachBell as any).storeIdentity({ externalId: 'u2' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await (ReachBell as any).syncSubscription();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('identify() during POST /subscribers', () => {
  beforeEach(() => {
    localStorage.clear();
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
    (ReachBell as any).identityMemory.clear();
    (ReachBell as any).serverContext = { vapidKeys: { public: VAPID } };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    (ReachBell as any).swReg = null;
  });

  const bodyOf = (spy: { mock: { calls: unknown[][] } }, call = 0) =>
    JSON.parse((spy.mock.calls[call][1] as RequestInit).body as string);
  const urlOf = (spy: { mock: { calls: unknown[][] } }, call = 0) => String(spy.mock.calls[call][0]);

  it('links the newer user after the registration that sent the older one succeeds', async () => {
    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).storeIdentity({ externalId: 'old_user' });
    let respond!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(new Promise<Response>(r => { respond = r; }))
      .mockResolvedValue(jsonResponse({ success: true }));
    const result = (ReachBell as any).subscribe();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    // No token yet: identify() only stores the new user.
    await expect(ReachBell.identify('new_user', { hash: 'nh' })).resolves.toEqual({ ok: false, reason: 'no_subscription' });
    respond(jsonResponse({ token: 't1' }));
    await expect(result).resolves.toEqual({ success: true, token: 't1' });
    expect(bodyOf(fetchSpy, 0).externalId).toBe('old_user');
    expect(urlOf(fetchSpy, 1)).toBe('https://x.test/subscribers/identify');
    expect(bodyOf(fetchSpy, 1)).toEqual({ token: 't1', externalId: 'new_user', identityHash: 'nh' });
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'new_user', hash: 'nh' });
  });

  it('a rejected hash does not clear a user identified while the registration was in flight', async () => {
    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).storeIdentity({ externalId: 'shopify_customer_1', hash: 'old' });
    let respond!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(new Promise<Response>(r => { respond = r; }))
      .mockResolvedValueOnce(jsonResponse({ token: 't1' }))
      .mockResolvedValue(jsonResponse({ success: true }));
    const result = (ReachBell as any).subscribe();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await ReachBell.identify('shopify_customer_1', { hash: 'fresh' });
    respond(jsonResponse({ success: false, reason: 'identity_hash_invalid' }, 201));
    // Identity wasn't dropped (a newer one replaced it), so no identityDropped flag.
    await expect(result).resolves.toEqual({ success: true, token: 't1' });
    expect(bodyOf(fetchSpy, 1).externalId).toBeUndefined();
    expect(bodyOf(fetchSpy, 2)).toEqual({ token: 't1', externalId: 'shopify_customer_1', identityHash: 'fresh' });
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'shopify_customer_1', hash: 'fresh' });
  });

  it('unlinks again when identify(null) lands while the registration that sent a user is in flight', async () => {
    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).storeIdentity({ externalId: 'u1' });
    let respond!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(new Promise<Response>(r => { respond = r; }))
      .mockResolvedValue(jsonResponse({ success: true }));
    const result = (ReachBell as any).subscribe();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    await ReachBell.identify(null);
    respond(jsonResponse({ token: 't1' }));
    await expect(result).resolves.toEqual({ success: true, token: 't1' });
    expect(urlOf(fetchSpy, 1)).toBe('https://x.test/subscribers/unidentify');
    expect(bodyOf(fetchSpy, 1)).toEqual({ token: 't1' });
  });

  it('fires reachbell:identity-dropped for a background re-subscribe that dropped the identity', async () => {
    const { reg } = fakeRegistration(true);
    (ReachBell as any).swReg = reg;
    (ReachBell as any).storeIdentity({ externalId: 'shopify_customer_7', hash: 'old' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ success: false, reason: 'identity_hash_invalid' }, 201))
      .mockResolvedValueOnce(jsonResponse({ token: 't9' }));
    const onDropped = vi.fn();
    window.addEventListener('reachbell:identity-dropped', onDropped);
    try {
      await (ReachBell as any).subscribe();
    } finally {
      window.removeEventListener('reachbell:identity-dropped', onDropped);
    }
    expect(onDropped).toHaveBeenCalledOnce();
    expect(onDropped.mock.calls[0][0].detail).toEqual({ externalId: 'shopify_customer_7' });
  });
});

describe('storage fallbacks', () => {
  beforeEach(() => {
    localStorage.clear();
    (ReachBell as any).config = { apiKey: 'k', apiUrl: 'https://x.test' };
    (ReachBell as any).token = null;
    (ReachBell as any).optedOutMemory.clear();
    (ReachBell as any).identityMemory.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  const blockStorage = () => {
    const fail = () => { throw new DOMException('denied', 'SecurityError'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(fail);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(fail);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(fail);
  };

  it('localStorage wins over the opt-out memory when storage works (e.g. another tab re-subscribed)', () => {
    (ReachBell as any).setOptedOut(true);
    expect((ReachBell as any).isOptedOut()).toBe(true);
    // Another tab's prompt() cleared the shared flag.
    localStorage.removeItem('reachbell_opted_out:k');
    expect((ReachBell as any).isOptedOut()).toBe(false);
  });

  it('keeps the opt-out in memory only while storage writes fail', () => {
    blockStorage();
    (ReachBell as any).setOptedOut(true);
    expect((ReachBell as any).isOptedOut()).toBe(true);
    (ReachBell as any).setOptedOut(false);
    expect((ReachBell as any).isOptedOut()).toBe(false);
  });

  it('remembers identify() in memory when localStorage is unavailable', async () => {
    blockStorage();
    await expect(ReachBell.identify('u1', { hash: 'h1' })).resolves.toEqual({ ok: false, reason: 'no_subscription' });
    expect((ReachBell as any).readIdentity()).toEqual({ externalId: 'u1', hash: 'h1', pending: true });
    await ReachBell.identify(null);
    expect((ReachBell as any).readIdentity()).toBeNull();
  });
});
