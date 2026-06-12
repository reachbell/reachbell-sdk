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
import { escapeHtml, safeColor, urlBase64ToUint8Array, ReachBell } from './index';

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
