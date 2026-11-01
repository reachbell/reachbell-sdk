/**
 * ReachBell official SDK.
 *
 *   import { ReachBell } from '@reachbell/sdk';
 *   ReachBell.init({ apiKey: 'rb_live_…' });
 *   await ReachBell.prompt();              // shows the configured opt-in prompt
 *   const r = await ReachBell.identify('user_42');
 *   if (!r.ok) console.warn(r.reason);
 *
 * The SDK auto-loads the service worker (reachbell-sw.js) and bridges
 * configuration from the server (GET /projects/context) — including the
 * dashboard-configured prompt UI.
 *
 * Design notes
 * ─────────────
 *   - init() is idempotent. A second call is a no-op unless `force:true`.
 *   - Every fetch is wrapped in a 10s AbortController budget so a hung
 *     network never deadlocks the bootstrap chain.
 *   - prompt() returns a discriminated SubscribeResult — it never throws
 *     for any failure mode the API contract acknowledges. SW-register and
 *     pushManager.subscribe() rejections are mapped to specific reasons.
 *   - Custom prompt UI is built via imperative DOM (element.style.X = v)
 *     instead of innerHTML with inline `style="…"` attributes, so it
 *     renders cleanly under `Content-Security-Policy: style-src 'self'`
 *     without needing 'unsafe-inline'.
 *   - The subscription token is mirrored in memory so identify()/tag()
 *     keep working through a Safari private-mode storage failure.
 *   - The class instance is exposed both as a named export and on
 *     `window.ReachBell` so theme + plugin integrations on WordPress
 *     end up sharing one client.
 */

export interface ReachBellConfig {
  apiKey:    string;
  apiUrl?:   string;
  swPath?:   string;
  autoPrompt?: boolean;
  debug?:    boolean;
  /** Force re-initialization (replaces config + re-runs bootstrap). */
  force?:    boolean;
}

export interface SubscribeResult {
  success: boolean;
  token?:  string;
  reason?: string;
}

export interface ApiResult {
  ok: boolean;
  reason?: string;
}

export type ToastPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface ToastOptions {
  /** Bold title line. Required. */
  title:       string;
  /** Subtitle / body line. Optional. */
  body?:       string;
  /** Click target — navigates the page when the card body is clicked. */
  url?:        string;
  /** Auto-dismiss delay in ms. Default 5000. Set 0 to disable auto-dismiss. */
  duration?:   number;
  /** Corner to stack toasts in. Default 'bottom-right'. */
  position?:   ToastPosition;
  /** Accent dot colour. Default ReachBell indigo. Validated by safeColor. */
  accentColor?: string;
}

export type BannerPosition = 'top' | 'bottom';

export interface BannerOptions {
  /** Headline text. Required. */
  title:           string;
  /** Optional subtitle. */
  body?:           string;
  /** Click-through URL — banner navigates when clicked. */
  url?:            string;
  /** Default 'top'. */
  position?:       BannerPosition;
  /** Auto-dismiss in ms. Default 0 (sticky). */
  duration?:       number;
  /** Background colour. Default ReachBell indigo. */
  backgroundColor?: string;
  /** Text colour. Default white. */
  textColor?:       string;
  /** Show × close button. Default true. */
  dismissible?:    boolean;
  /** Call-to-action button label. Optional — shows next to body when set. */
  ctaText?:        string;
}

export interface NotificationHistoryItem {
  id:        string;
  title:     string;
  body?:     string;
  url?:      string;
  iconUrl?:  string;
  receivedAt: number;     // epoch ms
  read?:     boolean;
}

export interface NotificationCenterOptions {
  /** Corner placement. Default 'bottom-right'. */
  position?:    ToastPosition;
  /** How many recent items to retain locally. Default 20. */
  maxItems?:    number;
  /** Override the accent colour. */
  accentColor?: string;
  /** Headline at the top of the dropdown. Default 'Notifications'. */
  title?:       string;
  /** Visible label when there are no items. */
  emptyText?:   string;
}

export interface PromptConfig {
  enabled: boolean;
  type:    'soft_prompt' | 'bell_widget' | 'native';
  title?:  string;
  body?:   string;
  acceptText?: string;
  declineText?: string;
  position?: string;
  accentColor?: string;
  iconUrl?: string;
  cardBackground?: string;
  cardTextColor?: string;
  buttonTextColor?: string;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: string;
  boxShadow?: string;
  allowButtonBackground?: string;
  allowButtonTextColor?: string;
  allowButtonBorderRadius?: number;
  declineButtonBackground?: string;
  declineButtonTextColor?: string;
  declineButtonBorderColor?: string;
  declineButtonBorderRadius?: number;
  showPoweredBy?: boolean;
  delay?: number;
  scrollPercent?: number;
  bellSize?: 'small' | 'medium' | 'large';
  bellTooltip?: string;
  bellPulse?: boolean;
  frequency?: { maxPerSession?: number; cooldownDays?: number };
}

const TOKEN_KEY            = 'reachbell_token';
const NOTIFICATION_HISTORY = 'reachbell_notif_history';
const DEFAULT_API_URL = 'https://api.reachbell.com';
const DEFAULT_SW_PATH = '/reachbell-sw.js';
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Brand primary — canonical ReachBell blue (`brand-600`). Source of
 * truth: BRAND.md at the repo root + tailwind config in the marketing
 * site. Do NOT drift toward Tailwind's default indigo `#6366f1` — that
 * shifts purple and clashes with the rest of the surfaces.
 */
const DEFAULT_ACCENT = '#2563EB';
const DEFAULT_TITLE  = 'Stay in the loop';
const DEFAULT_ACCEPT = 'Allow';
const DEFAULT_DECLINE = 'Not now';

/* ─── Pure helpers — exported for testability ─────────────────── */

/** Escape the 5 HTML chars that matter inside element bodies + attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Accept only well-formed CSS colour strings before applying them to an
 * `element.style.X` property. Anything else falls back to the default.
 *
 * Server-controlled values (the dashboard's promptConfig.accentColor)
 * route through here so a compromised admin can't inject extra CSS
 * properties / pseudo-element overlays / `javascript:` URLs.
 */
export function safeColor(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  // hex: #abc, #aabbcc, #aabbccdd (with optional alpha)
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(input)) return input;
  // rgb/rgba/hsl/hsla with conservative char set — no quotes, parens, semis, url()
  if (/^(?:rgb|hsl)a?\(\s*[\d.\s,%/-]+\s*\)$/i.test(input)) return input;
  return fallback;
}

/**
 * Decode the URL-safe base64 VAPID public key into a Uint8Array backed by
 * a real ArrayBuffer (not ArrayBufferLike) so it satisfies BufferSource
 * under TS ≥5.7 strict typing.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/* ─── Client ──────────────────────────────────────────────────── */

class ReachBellClient {
  private config: ReachBellConfig | null = null;
  private promptConfig: PromptConfig | null = null;
  private serverContext: any = null;
  private swReg: ServiceWorkerRegistration | null = null;
  private bootstrapping: Promise<void> | null = null;
  private warned = false;
  /**
   * In-memory mirror of the subscription token. Used as a fallback when
   * localStorage throws (Safari private mode, quota exceeded) so the very
   * next identify()/tag() call doesn't see no_subscription right after a
   * successful subscribe() in the same session.
   */
  private token: string | null = null;

  init(config: ReachBellConfig): void {
    if (this.config && !config.force) {
      this.log('init() called twice — ignoring. Pass force:true to override.');
      return;
    }
    this.config = {
      apiUrl:     DEFAULT_API_URL,
      swPath:     DEFAULT_SW_PATH,
      autoPrompt: false,
      debug:      false,
      ...config,
    };
    this.log('Initialized', this.config);
    this.bootstrapping = this.bootstrap();
    void this.bootstrapping;
  }

  /** Resolves once the boot chain (context + SW registration) has settled. */
  get ready(): Promise<void> {
    return this.bootstrapping ?? Promise.reject(new Error('Call ReachBell.init() first'));
  }

  private async bootstrap(): Promise<void> {
    try {
      const ctx = await this.fetchContext();
      this.serverContext = ctx;
      this.promptConfig  = ctx.promptConfig ?? null;
      await this.registerServiceWorker();
      const isBellWidget = this.promptConfig?.type === 'bell_widget' || (this.promptConfig as any)?.bellWidget?.enabled;
      if (this.promptConfig && this.promptConfig.enabled !== false && isBellWidget) {
        this.mountBellWidget(this.promptConfig);
      }
      const shouldAutoPrompt = this.config?.autoPrompt === true || (this.config?.autoPrompt !== false && this.promptConfig?.enabled);
      if (shouldAutoPrompt && !isBellWidget && this.promptConfig?.enabled) {
        const delaySec = (this.promptConfig as any)?.delay ?? 1;
        const delayMs = Math.max(0, delaySec * 1000);
        setTimeout(() => {
          if (typeof Notification === 'undefined' || Notification.permission === 'default') {
            void this.prompt();
          }
        }, delayMs);
      }
    } catch (e) {
      this.warnOnce('Bootstrap failed — push notifications will not work on this page', e);
      this.log('Bootstrap failed', e);
    }
  }

  private armAutoPromptOnGesture(): void {
    if (typeof document === 'undefined') return;
    const events = ['click', 'keydown', 'touchstart'] as const;
    const fire = () => {
      events.forEach(ev => document.removeEventListener(ev, fire));
      void this.prompt();
    };
    events.forEach(ev => document.addEventListener(ev, fire, { once: true, passive: true }));
  }

  /**
   * Shared fetch wrapper. Adds the API key, sets a hard timeout (default
   * 10s), and links any caller-provided AbortSignal so cancellation from
   * either source aborts the fetch.
   */
  private async request(
    path: string,
    init: RequestInit = {},
    ms: number = DEFAULT_TIMEOUT_MS,
  ): Promise<Response> {
    if (!this.config) throw new Error('Call ReachBell.init() first');
    const ctrl = new AbortController();
    const outerSignal = init.signal;
    const onOuterAbort = () => ctrl.abort();
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(`${this.config.apiUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          'x-api-key': this.config.apiKey,
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private async fetchContext(): Promise<any> {
    const res = await this.request('/projects/context');
    if (!res.ok) throw new Error(`Failed to fetch ReachBell context (status ${res.status})`);
    return res.json();
  }

  private async registerServiceWorker(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      this.log('Service workers not supported');
      return;
    }
    this.swReg = await navigator.serviceWorker.register(this.config!.swPath!);
    this.log('SW registered', this.swReg);
  }

  async prompt(): Promise<SubscribeResult> {
    if (!this.config) return { success: false, reason: 'sdk_not_initialized' };

    // Wait for the in-flight bootstrap so prompt() called immediately after
    // init() doesn't race a missing serverContext / swReg.
    if (this.bootstrapping) {
      try { await this.bootstrapping; } catch { /* already warned */ }
    }
    if (!('PushManager' in window)) return { success: false, reason: 'push_not_supported' };

    if (!this.swReg) {
      try {
        await this.registerServiceWorker();
      } catch (e: any) {
        return { success: false, reason: `sw_register_failed_${e?.name ?? 'unknown'}` };
      }
    }

    if (this.promptConfig?.enabled && this.promptConfig.type !== 'native') {
      const accepted = await this.showCustomPrompt(this.promptConfig);
      if (!accepted) return { success: false, reason: 'user_declined_soft_prompt' };
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { success: false, reason: 'permission_denied' };

    return this.subscribe();
  }

  private async subscribe(): Promise<SubscribeResult> {
    if (!this.swReg || !this.serverContext) return { success: false, reason: 'not_ready' };
    let sub: PushSubscription;
    try {
      sub = await this.swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(this.serverContext.vapidKeys.public),
      });
    } catch (e: any) {
      // NotAllowedError, AbortError, InvalidStateError, InvalidAccessError,
      // and missing/malformed VAPID keys all land here. Map to a specific
      // reason so the integrator can branch on what failed.
      return { success: false, reason: `push_subscribe_failed_${e?.name ?? 'unknown'}` };
    }

    try {
      const res = await this.request('/subscribers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `subscription` is the canonical structured shape. `token` is kept
        // as the legacy double-stringified form so an older API stays
        // compatible during rollout — remove from the wire format in v2.
        body: JSON.stringify({
          subscription: sub.toJSON(),
          token:        JSON.stringify(sub),
          tokenType:    'vapid',
        }),
      });
      if (!res.ok) return { success: false, reason: `subscribe_failed_${res.status}` };
      const data = await res.json();
      const t: string | null = data.token ?? null;
      this.token = t;
      // Safari private mode + quota-exceeded both throw here. The in-memory
      // mirror above keeps identify()/tag() working for the session anyway.
      try { if (t) localStorage.setItem(TOKEN_KEY, t); } catch { /* fall back to memory */ }
      return { success: true, token: t ?? undefined };
    } catch (e: any) {
      return { success: false, reason: e?.name === 'AbortError' ? 'timed_out' : 'network_error' };
    }
  }

  async identify(externalId: string): Promise<ApiResult> {
    if (!this.config) return { ok: false, reason: 'sdk_not_initialized' };
    const token = this.readToken();
    if (!token)       return { ok: false, reason: 'no_subscription' };
    return this.postJson('/subscribers/identify', { token, externalId });
  }

  async tag(tags: string[]): Promise<ApiResult> {
    if (!this.config) return { ok: false, reason: 'sdk_not_initialized' };
    const token = this.readToken();
    if (!token)       return { ok: false, reason: 'no_subscription' };
    return this.postJson('/subscribers/tag', { token, tags });
  }

  private async postJson(path: string, body: unknown): Promise<ApiResult> {
    try {
      const res = await this.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok ? { ok: true } : { ok: false, reason: `server_${res.status}` };
    } catch (e: any) {
      return { ok: false, reason: e?.name === 'AbortError' ? 'timed_out' : 'network_error' };
    }
  }

  /**
   * Show an in-page toast notification. Returns a function that dismisses
   * the toast early; toasts also auto-dismiss after `duration` ms
   * (default 5000). Multiple toasts stack at the chosen corner.
   *
   * Unlike push notifications, toasts don't require permission — they
   * render entirely inside the page DOM, useful for real-time alerts
   * to users who are already on your site.
   *
   *   const dismiss = ReachBell.showToast({
   *     title:    'Order shipped 📦',
   *     body:     'Order #4821 arrives tomorrow.',
   *     url:      '/orders/4821',
   *     duration: 6000,
   *   });
   */
  showToast(opts: ToastOptions): () => void {
    if (typeof document === 'undefined') return () => {};
    const defaults = this.serverContext?.customLayouts?.toast ?? {};
    const layer = this.ensureToastLayer(opts.position ?? defaults.position ?? 'bottom-right');
    const accent  = safeColor(opts.accentColor ?? defaults.accentColor, DEFAULT_ACCENT);
    const duration = typeof opts.duration === 'number'
      ? Math.max(0, opts.duration)
      : (typeof defaults.duration === 'number' ? defaults.duration : 5000);

    const card = document.createElement('div');
    Object.assign(card.style, {
      background:   '#0f172a',
      color:        '#f8fafc',
      borderRadius: '12px',
      boxShadow:    '0 18px 50px rgba(15,23,42,.35)',
      padding:      '12px 14px',
      width:        '320px',
      maxWidth:     'calc(100vw - 40px)',
      cursor:       opts.url ? 'pointer' : 'default',
      display:      'flex',
      gap:          '10px',
      alignItems:   'flex-start',
      transition:   'opacity 150ms ease, transform 150ms ease',
      opacity:      '0',
      transform:    'translateY(8px)',
    });

    const dot = document.createElement('div');
    Object.assign(dot.style, {
      width: '8px', height: '8px', borderRadius: '999px',
      background: accent, marginTop: '7px', flexShrink: '0',
    });
    card.appendChild(dot);

    const text = document.createElement('div');
    Object.assign(text.style, { flex: '1', minWidth: '0' });

    const titleEl = document.createElement('div');
    Object.assign(titleEl.style, { fontSize: '13.5px', fontWeight: '700', lineHeight: '1.25' });
    titleEl.textContent = opts.title;
    text.appendChild(titleEl);

    if (opts.body) {
      const bodyEl = document.createElement('div');
      Object.assign(bodyEl.style, {
        fontSize: '12px', color: '#cbd5e1', marginTop: '3px', lineHeight: '1.4',
      });
      bodyEl.textContent = opts.body;
      text.appendChild(bodyEl);
    }
    card.appendChild(text);

    const close = document.createElement('button');
    Object.assign(close.style, {
      border: '0', background: 'transparent', color: '#94a3b8',
      padding: '0', cursor: 'pointer', fontSize: '14px', lineHeight: '1',
      marginLeft: '4px', flexShrink: '0',
    });
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    card.appendChild(close);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      card.style.opacity = '0';
      card.style.transform = 'translateY(8px)';
      setTimeout(() => card.remove(), 200);
    };

    close.addEventListener('click', e => { e.stopPropagation(); dismiss(); });
    if (opts.url) {
      card.addEventListener('click', () => {
        try { window.location.href = opts.url!; } catch { /* navigation blocked */ }
        dismiss();
      });
    }

    layer.appendChild(card);
    // Animate in on the next frame so the transition fires.
    requestAnimationFrame(() => {
      card.style.opacity   = '1';
      card.style.transform = 'translateY(0)';
    });

    if (duration > 0) setTimeout(dismiss, duration);
    return dismiss;
  }

  private ensureToastLayer(position: ToastPosition): HTMLDivElement {
    const id = `reachbell-toast-layer-${position}`;
    let layer = document.getElementById(id) as HTMLDivElement | null;
    if (layer) return layer;

    layer = document.createElement('div');
    layer.id = id;
    Object.assign(layer.style, {
      position:      'fixed',
      zIndex:        '2147483646',
      pointerEvents: 'none',
      display:       'flex',
      flexDirection: 'column',
      gap:           '10px',
      maxWidth:      '360px',
    });
    // Pin to the appropriate corner.
    if (position.startsWith('top'))    layer.style.top    = '20px';
    if (position.startsWith('bottom')) layer.style.bottom = '20px';
    if (position.endsWith('right'))    layer.style.right  = '20px';
    if (position.endsWith('left'))     layer.style.left   = '20px';

    // Children inherit pointer-events: auto so cards remain interactive
    // while the layer itself doesn't block clicks elsewhere on the page.
    const style = document.createElement('style');
    style.textContent = `#${id} > * { pointer-events: auto; }`;
    layer.appendChild(style);

    document.body.appendChild(layer);
    return layer;
  }

  /**
   * Apply UTM parameters to every outbound link click on the page,
   * tagging traffic so Google Analytics / etc. attribute the session to
   * ReachBell as the source. Safe to call repeatedly — installs a single
   * delegated click listener regardless of how many times it's invoked.
   *
   *   ReachBell.attachUtmTagger({
   *     source:   'reachbell',
   *     medium:   'push',
   *     campaign: 'fall-2026',
   *   });
   */
  attachUtmTagger(utm: { source: string; medium: string; campaign?: string; term?: string; content?: string }): void {
    if (typeof document === 'undefined' || (this as any)._utmHandlerInstalled) return;
    (this as any)._utmHandlerInstalled = true;

    const apply = (target: HTMLAnchorElement | null) => {
      if (!target || !target.href) return;
      try {
        const u = new URL(target.href, window.location.href);
        // Skip same-origin links — UTM is for outbound attribution only.
        if (u.origin === window.location.origin) return;
        if (!u.searchParams.has('utm_source'))   u.searchParams.set('utm_source',   utm.source);
        if (!u.searchParams.has('utm_medium'))   u.searchParams.set('utm_medium',   utm.medium);
        if (utm.campaign && !u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', utm.campaign);
        if (utm.term     && !u.searchParams.has('utm_term'))     u.searchParams.set('utm_term',     utm.term);
        if (utm.content  && !u.searchParams.has('utm_content'))  u.searchParams.set('utm_content',  utm.content);
        target.href = u.toString();
      } catch { /* malformed href — ignore */ }
    };

    // Capture phase so we run before any user click handler that might
    // call preventDefault / change the href.
    document.addEventListener('click', ev => {
      const path = (ev.composedPath?.() ?? []) as Element[];
      const anchor = path.find(el => (el as HTMLElement)?.tagName === 'A') as HTMLAnchorElement | undefined;
      apply(anchor ?? null);
    }, true);
  }

  /**
   * Show a sticky banner across the top or bottom of the viewport. Returns
   * a `dismiss()` function. Banners are stacked one-per-position, so a
   * second call replaces the first at the same position.
   *
   * Common uses: site-wide announcements, sale promotions, system alerts
   * that need higher visibility than a corner toast.
   *
   *   const dismiss = ReachBell.showBanner({
   *     title:   '🚀 Black Friday — 30% off everything',
   *     body:    'Code BLACK30 — ends midnight',
   *     ctaText: 'Shop now',
   *     url:     '/sale',
   *   });
   */
  showBanner(opts: BannerOptions): () => void {
    if (typeof document === 'undefined') return () => {};

    const defaults = this.serverContext?.customLayouts?.banner ?? {};
    const position = opts.position ?? defaults.position ?? 'top';
    const dismissible = opts.dismissible !== undefined
      ? opts.dismissible
      : (defaults.dismissible !== undefined ? defaults.dismissible : true);
    const bg   = safeColor(opts.backgroundColor ?? defaults.backgroundColor, DEFAULT_ACCENT);
    const text = safeColor(opts.textColor       ?? defaults.textColor,       '#ffffff');

    // Only one banner per position. Replacing dismisses the previous so
    // the page never accumulates a stack of overlapping bars.
    const layerId = `reachbell-banner-${position}`;
    document.getElementById(layerId)?.remove();

    const bar = document.createElement('div');
    bar.id = layerId;
    Object.assign(bar.style, {
      position:    'fixed',
      left:        '0', right: '0',
      [position]:  '0',
      background:  bg,
      color:       text,
      padding:     '10px 16px',
      zIndex:      '2147483645',
      display:     'flex',
      alignItems:  'center',
      justifyContent: 'center',
      gap:         '14px',
      fontFamily:  'system-ui, -apple-system, Segoe UI, sans-serif',
      fontSize:    '13px',
      lineHeight:  '1.35',
      boxShadow:   position === 'top'
        ? '0 6px 18px rgba(0,0,0,.12)'
        : '0 -6px 18px rgba(0,0,0,.12)',
      cursor:      opts.url ? 'pointer' : 'default',
      transition:  'transform 200ms ease',
      transform:   position === 'top' ? 'translateY(-100%)' : 'translateY(100%)',
    });

    const content = document.createElement('div');
    Object.assign(content.style, {
      display:     'flex',
      alignItems:  'baseline',
      gap:         '10px',
      flexWrap:    'wrap',
      justifyContent: 'center',
    });

    const titleEl = document.createElement('strong');
    titleEl.style.fontWeight = '700';
    titleEl.textContent = opts.title;
    content.appendChild(titleEl);

    if (opts.body) {
      const bodyEl = document.createElement('span');
      bodyEl.style.opacity = '0.92';
      bodyEl.textContent = opts.body;
      content.appendChild(bodyEl);
    }

    if (opts.ctaText) {
      const cta = document.createElement('span');
      Object.assign(cta.style, {
        marginLeft:    '6px',
        textDecoration:'underline',
        fontWeight:    '700',
        cursor:        'pointer',
      });
      cta.textContent = opts.ctaText;
      content.appendChild(cta);
    }
    bar.appendChild(content);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      bar.style.transform = position === 'top' ? 'translateY(-100%)' : 'translateY(100%)';
      setTimeout(() => bar.remove(), 220);
    };

    if (dismissible) {
      const close = document.createElement('button');
      Object.assign(close.style, {
        background: 'transparent', border: '0', color: text,
        opacity: '0.85', cursor: 'pointer', fontSize: '16px',
        lineHeight: '1', padding: '0 4px', marginLeft: '8px',
      });
      close.setAttribute('aria-label', 'Dismiss banner');
      close.textContent = '×';
      close.addEventListener('click', e => { e.stopPropagation(); dismiss(); });
      bar.appendChild(close);
    }

    if (opts.url) {
      bar.addEventListener('click', () => {
        try { window.location.href = opts.url!; } catch { /* navigation blocked */ }
      });
    }

    document.body.appendChild(bar);
    requestAnimationFrame(() => { bar.style.transform = 'translateY(0)'; });

    const duration = typeof opts.duration === 'number'
      ? opts.duration
      : (typeof defaults.duration === 'number' ? defaults.duration : 0);
    if (duration > 0) setTimeout(dismiss, duration);

    return dismiss;
  }

  /**
   * Record a notification in the local history store. Hosts call this from
   * the service worker (or anywhere they receive a push payload) so the
   * notification center widget can show a recent feed. Bounded to
   * `maxItems` newest, oldest evicted FIFO.
   *
   * Safe to call before init() — items still get persisted.
   */
  recordNotification(item: Partial<NotificationHistoryItem> & { title: string }): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const existing = this.readNotificationHistory();
      const next: NotificationHistoryItem = {
        id:         item.id         ?? `nh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        title:      item.title,
        body:       item.body,
        url:        item.url,
        iconUrl:    item.iconUrl,
        receivedAt: item.receivedAt ?? Date.now(),
        read:       !!item.read,
      };
      const merged = [next, ...existing].slice(0, 50); // hard cap regardless of viewer
      localStorage.setItem(NOTIFICATION_HISTORY, JSON.stringify(merged));
      // Push a CustomEvent so an open notification center can refresh.
      try { window.dispatchEvent(new CustomEvent('reachbell:notification-recorded', { detail: next })); }
      catch { /* CustomEvent unsupported — best-effort */ }
    } catch { /* JSON or quota — drop silently */ }
  }

  /** Read up to `limit` items, newest first. */
  getNotificationHistory(limit = 20): NotificationHistoryItem[] {
    const all = this.readNotificationHistory();
    return all.slice(0, Math.max(0, limit));
  }

  /** Clear all stored notifications. */
  clearNotificationHistory(): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.removeItem(NOTIFICATION_HISTORY); } catch { /* ignore */ }
  }

  private readNotificationHistory(): NotificationHistoryItem[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(NOTIFICATION_HISTORY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  /**
   * Render a floating bell-icon button anchored in a corner; clicking it
   * opens a dropdown of recent notifications pulled from
   * recordNotification() history. Calling twice replaces the existing
   * widget so callers can re-skin without reloading the page.
   *
   *   ReachBell.showNotificationCenter({ position: 'bottom-right' });
   */
  showNotificationCenter(opts: NotificationCenterOptions = {}): () => void {
    if (typeof document === 'undefined') return () => {};
    const defaults = this.serverContext?.customLayouts?.notificationCenter ?? {};
    const position = opts.position ?? defaults.position ?? 'bottom-right';
    const accent   = safeColor(opts.accentColor ?? defaults.accentColor, DEFAULT_ACCENT);
    const maxItems = opts.maxItems ?? defaults.maxItems ?? 20;
    const heading  = opts.title ?? defaults.title ?? 'Notifications';
    const emptyTx  = opts.emptyText ?? 'No notifications yet.';

    const id = 'reachbell-notification-center';
    document.getElementById(id)?.remove();

    const root = document.createElement('div');
    root.id = id;
    Object.assign(root.style, {
      position: 'fixed', zIndex: '2147483645',
      fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
    });
    if (position.startsWith('top'))    root.style.top    = '20px';
    if (position.startsWith('bottom')) root.style.bottom = '20px';
    if (position.endsWith('right'))    root.style.right  = '20px';
    if (position.endsWith('left'))     root.style.left   = '20px';

    // Bell button.
    const bell = document.createElement('button');
    Object.assign(bell.style, {
      width: '46px', height: '46px', borderRadius: '999px',
      background: accent, color: '#fff', border: '0',
      cursor: 'pointer', boxShadow: '0 8px 24px rgba(15,23,42,.25)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '0', position: 'relative',
    });
    bell.setAttribute('aria-label', heading);
    // Inline SVG — no external asset, no remote font.
    bell.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
      + '<path d="M12 22a2.5 2.5 0 0 0 2.45-2H9.55A2.5 2.5 0 0 0 12 22Zm6.36-6.36V11a6.36 6.36 0 1 0-12.72 0v4.64L4 17.27v.91h16v-.91l-1.64-1.63Z" fill="currentColor"/>'
      + '</svg>';

    // Unread badge.
    const badge = document.createElement('span');
    Object.assign(badge.style, {
      position: 'absolute', top: '-2px', right: '-2px',
      background: '#ef4444', color: '#fff', borderRadius: '999px',
      minWidth: '18px', height: '18px', padding: '0 5px',
      fontSize: '10px', fontWeight: '800', lineHeight: '18px',
      display: 'none', boxShadow: '0 0 0 2px #fff',
    });
    bell.appendChild(badge);

    // Dropdown panel.
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute',
      [position.startsWith('top')    ? 'top'    : 'bottom']: '56px',
      [position.endsWith('right')    ? 'right'  : 'left']:   '0',
      width:     '320px',
      maxHeight: '420px',
      overflow:  'hidden',
      display:   'none',
      flexDirection: 'column',
      background: '#fff', color: '#0f172a',
      borderRadius: '14px',
      boxShadow:    '0 20px 50px rgba(15,23,42,.22)',
      border: '1px solid rgba(15,23,42,.08)',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 14px', borderBottom: '1px solid rgba(15,23,42,.08)',
      fontWeight: '700', fontSize: '13.5px',
    });
    const title = document.createElement('span');
    title.textContent = heading;
    const clear = document.createElement('button');
    Object.assign(clear.style, {
      background: 'transparent', border: '0', color: '#64748b',
      cursor: 'pointer', fontSize: '11.5px', fontWeight: '600',
    });
    clear.textContent = 'Clear';
    header.append(title, clear);

    const list = document.createElement('div');
    Object.assign(list.style, { overflowY: 'auto', flex: '1' });

    panel.append(header, list);
    root.append(bell, panel);
    document.body.appendChild(root);

    const render = () => {
      const items = this.getNotificationHistory(maxItems);
      const unread = items.filter(i => !i.read).length;
      badge.style.display = unread > 0 ? 'inline-block' : 'none';
      badge.textContent = unread > 99 ? '99+' : String(unread);

      list.replaceChildren();
      if (items.length === 0) {
        const empty = document.createElement('div');
        Object.assign(empty.style, {
          padding: '28px 16px', textAlign: 'center', color: '#94a3b8',
          fontSize: '12.5px',
        });
        empty.textContent = emptyTx;
        list.appendChild(empty);
        return;
      }
      items.forEach(item => {
        const row = document.createElement('div');
        Object.assign(row.style, {
          padding: '12px 14px', cursor: item.url ? 'pointer' : 'default',
          borderBottom: '1px solid rgba(15,23,42,.05)',
          background: item.read ? 'transparent' : 'rgba(99,102,241,.06)',
        });
        const t = document.createElement('div');
        Object.assign(t.style, { fontSize: '13px', fontWeight: '700' });
        t.textContent = item.title;
        row.appendChild(t);
        if (item.body) {
          const b = document.createElement('div');
          Object.assign(b.style, {
            fontSize: '12px', color: '#475569', marginTop: '2px',
            lineHeight: '1.4',
          });
          b.textContent = item.body;
          row.appendChild(b);
        }
        const time = document.createElement('div');
        Object.assign(time.style, {
          fontSize: '10.5px', color: '#94a3b8', marginTop: '4px',
          fontWeight: '600',
        });
        time.textContent = this.relativeTime(item.receivedAt);
        row.appendChild(time);

        row.addEventListener('click', () => {
          item.read = true;
          this.markRead(item.id);
          render();
          if (item.url) {
            try { window.location.href = item.url; } catch { /* navigation blocked */ }
          }
        });
        list.appendChild(row);
      });
    };

    let open = false;
    const toggle = () => {
      open = !open;
      panel.style.display = open ? 'flex' : 'none';
      if (open) render();
    };
    bell.addEventListener('click', toggle);
    clear.addEventListener('click', e => {
      e.stopPropagation();
      this.clearNotificationHistory();
      render();
    });
    // Close on outside click.
    const outside = (ev: MouseEvent) => {
      if (!open) return;
      if (!root.contains(ev.target as Node)) {
        open = false;
        panel.style.display = 'none';
      }
    };
    document.addEventListener('click', outside);

    // Live update when recordNotification() fires while open.
    const liveHandler = () => { if (open) render(); else { render(); /* still updates the badge */ } };
    window.addEventListener('reachbell:notification-recorded', liveHandler);

    // Initial badge render so unread count is visible immediately.
    render();

    return () => {
      document.removeEventListener('click', outside);
      window.removeEventListener('reachbell:notification-recorded', liveHandler);
      root.remove();
    };
  }

  /**
   * Render an interactive floating bell launcher on the page.
   * Automatically mounted during bootstrap if configured in the dashboard.
   */
  showBellWidget(options?: any): () => void {
    const cfg = options ?? this.promptConfig ?? {};
    return this.mountBellWidget(cfg);
  }

  private mountBellWidget(cfg: any): () => void {
    if (typeof document === 'undefined') return () => {};
    const id = 'reachbell-bell-widget';
    document.getElementById(id)?.remove();

    const position = cfg.position || cfg.bellWidget?.position || 'bottom-right';
    const accent = safeColor(cfg.accentColor || cfg.bellWidget?.color, DEFAULT_ACCENT);
    const sizeStr = cfg.bellSize || cfg.bellWidget?.size || 'medium';
    const sizePx = sizeStr === 'small' ? 40 : sizeStr === 'large' ? 56 : 48;
    const tooltipText = cfg.bellTooltip || cfg.bellWidget?.tooltipText || 'Enable notifications';
    const pulse = cfg.bellPulse !== false && cfg.bellWidget?.pulseAnimation !== false;

    if (!document.getElementById('reachbell-bell-styles')) {
      const style = document.createElement('style');
      style.id = 'reachbell-bell-styles';
      style.textContent = `
        @keyframes rb-bell-ping {
          0% { transform: scale(1); opacity: 0.6; }
          75%, 100% { transform: scale(1.6); opacity: 0; }
        }
        .rb-bell-pulse {
          position: absolute; inset: 0; border-radius: 9999px;
          animation: rb-bell-ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;
          pointer-events: none;
        }
        .rb-bell-btn:hover .rb-bell-tooltip {
          opacity: 1 !important;
          transform: translateY(0) !important;
          pointer-events: auto !important;
        }
      `;
      document.head.appendChild(style);
    }

    const container = document.createElement('div');
    container.id = id;
    container.className = 'rb-bell-btn';
    Object.assign(container.style, {
      position: 'fixed',
      zIndex: '2147483640',
      display: 'flex',
      flexDirection: 'column',
      alignItems: position.endsWith('left') ? 'flex-start' : 'flex-end',
      fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      transition: 'transform 0.2s ease',
    });

    if (position.startsWith('top'))    container.style.top    = '20px';
    if (position.startsWith('bottom')) container.style.bottom = '20px';
    if (position.endsWith('right'))    container.style.right  = '20px';
    if (position.endsWith('left'))     container.style.left   = '20px';

    if (tooltipText) {
      const tooltip = document.createElement('div');
      tooltip.className = 'rb-bell-tooltip';
      Object.assign(tooltip.style, {
        padding: '6px 12px',
        borderRadius: '8px',
        background: '#0f172a',
        color: '#ffffff',
        fontSize: '11px',
        fontWeight: '600',
        boxShadow: '0 10px 25px -5px rgba(0,0,0,0.3)',
        whiteSpace: 'nowrap',
        marginBottom: '8px',
        opacity: '0',
        transform: 'translateY(4px)',
        transition: 'opacity 0.2s ease, transform 0.2s ease',
        pointerEvents: 'none',
      });
      tooltip.textContent = tooltipText;
      container.appendChild(tooltip);
    }

    const btnWrap = document.createElement('div');
    Object.assign(btnWrap.style, {
      position: 'relative',
      width: `${sizePx}px`,
      height: `${sizePx}px`,
    });

    if (pulse) {
      const pulseRing = document.createElement('div');
      pulseRing.className = 'rb-bell-pulse';
      pulseRing.style.background = accent;
      btnWrap.appendChild(pulseRing);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', tooltipText);
    Object.assign(button.style, {
      width: `${sizePx}px`,
      height: `${sizePx}px`,
      borderRadius: '9999px',
      background: accent,
      color: '#ffffff',
      border: 'none',
      cursor: 'pointer',
      boxShadow: '0 10px 25px -3px rgba(0,0,0,0.25)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      zIndex: '1',
      transition: 'transform 0.15s ease, box-shadow 0.15s ease',
      outline: 'none',
      padding: '0',
    });

    const iconSize = Math.round(sizePx * 0.45);
    button.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;

    button.addEventListener('mouseenter', () => {
      button.style.transform = 'scale(1.08)';
    });
    button.addEventListener('mouseleave', () => {
      button.style.transform = 'scale(1)';
    });

    button.addEventListener('click', async () => {
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') {
          this.showToast({
            title: 'Notifications Active',
            body: 'You are subscribed to receive updates from this site.',
            duration: 3500,
            accentColor: accent,
          });
          return;
        } else if (Notification.permission === 'denied') {
          this.showToast({
            title: 'Notifications Blocked',
            body: 'Notifications are blocked in your browser settings. Click the site settings icon to allow.',
            duration: 5000,
            accentColor: '#ef4444',
          });
          return;
        }
      }
      await this.prompt();
    });

    btnWrap.appendChild(button);
    container.appendChild(btnWrap);
    document.body.appendChild(container);

    return () => container.remove();
  }

  private markRead(id: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const next = this.readNotificationHistory().map(i =>
        i.id === id ? { ...i, read: true } : i,
      );
      localStorage.setItem(NOTIFICATION_HISTORY, JSON.stringify(next));
    } catch { /* ignore */ }
  }

  private relativeTime(epochMs: number): string {
    const diff = Math.max(0, Date.now() - epochMs);
    const s = Math.floor(diff / 1000);
    if (s < 60)        return 'just now';
    if (s < 3600)      return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400)    return `${Math.floor(s / 3600)}h ago`;
    if (s < 86_400*7)  return `${Math.floor(s / 86_400)}d ago`;
    return new Date(epochMs).toLocaleDateString();
  }

  /** Read order: in-memory mirror → localStorage. Survives Safari private mode. */
  private readToken(): string | null {
    if (this.token) return this.token;
    try {
      const t = localStorage.getItem(TOKEN_KEY);
      if (t) this.token = t;
      return t;
    } catch {
      return null;
    }
  }

  /**
   * Build the prompt UI imperatively via element.style.* assignments instead
   * of an innerHTML template with inline `style="…"` attributes. JS-set styles
   * are NOT gated by `Content-Security-Policy: style-src` — only
   * parser-processed style attributes are — so this renders cleanly on
   * customer sites with strict CSP.
   */
  private async showCustomPrompt(cfg: PromptConfig): Promise<boolean> {
    return new Promise(resolve => {
      // Clean up any existing prompt before showing a new one
      document.getElementById('reachbell-custom-prompt')?.remove();

      const accent = safeColor(cfg.accentColor, DEFAULT_ACCENT);
      const rawPos = cfg.position || (cfg as any).softPrompt?.position || 'bottom-center';
      const pos = rawPos.toLowerCase().replace(/_/g, '-');
      const isCenterModal = pos === 'center-modal';
      const isTopBar = pos === 'top-bar' || pos === 'banner';

      const allowBg = safeColor(cfg.allowButtonBackground || cfg.accentColor, accent);
      const allowColor = safeColor(cfg.allowButtonTextColor || cfg.buttonTextColor, '#ffffff');
      const allowRadius = cfg.allowButtonBorderRadius ?? 10;

      const declineBg = safeColor(cfg.declineButtonBackground, '#f8fafc');
      const declineColor = safeColor(cfg.declineButtonTextColor, '#475569');
      const declineBorder = safeColor(cfg.declineButtonBorderColor, '#e2e8f0');
      const declineRadius = cfg.declineButtonBorderRadius ?? 10;

      const cardBg = safeColor(cfg.cardBackground, '#ffffff');
      const cardText = safeColor(cfg.cardTextColor, '#0f172a');
      const cardBorder = safeColor(cfg.borderColor, '#e2e8f0');
      const cardBorderWidth = typeof cfg.borderWidth === 'number' ? cfg.borderWidth : 1;
      const cardRadius = isTopBar ? 0 : (typeof cfg.borderRadius === 'number' ? cfg.borderRadius : 16);

      const shadowMap: Record<string, string> = {
        none: 'none',
        sm:   '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)',
        md:   '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)',
        xl:   '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
        '2xl': '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        glow: `0 12px 36px -4px ${(cfg.accentColor && cfg.accentColor.startsWith('#') && cfg.accentColor.length === 7) ? `${cfg.accentColor}45` : 'rgba(99, 102, 241, 0.35)'}`,
      };
      const cardShadow = shadowMap[cfg.boxShadow || ''] || '0 20px 45px -10px rgba(15,23,42,.22), 0 0 0 1px rgba(0,0,0,0.06)';

      const root = document.createElement('div');
      root.id = 'reachbell-custom-prompt';
      Object.assign(root.style, {
        position: 'fixed',
        zIndex:   '2147483647',
        fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      });

      if (isCenterModal) {
        Object.assign(root.style, {
          inset: '0',
          width: '100vw',
          height: '100vh',
          background: 'rgba(15, 23, 42, 0.48)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px',
          boxSizing: 'border-box',
          pointerEvents: 'auto',
        });
      } else if (isTopBar) {
        Object.assign(root.style, {
          top: '0',
          left: '0',
          right: '0',
          width: '100%',
          pointerEvents: 'auto',
        });
      } else {
        Object.assign(root.style, {
          pointerEvents: 'none',
        });
        if (pos.startsWith('bottom')) root.style.bottom = '24px';
        if (pos.startsWith('top'))    root.style.top    = '24px';
        if (pos.includes('center'))   { root.style.left = '50%'; root.style.transform = 'translateX(-50%)'; }
        if (pos.endsWith('left'))     root.style.left  = '24px';
        if (pos.endsWith('right'))    root.style.right = '24px';
      }

      if (isTopBar) {
        const banner = document.createElement('div');
        Object.assign(banner.style, {
          width: '100%',
          background: cardBg,
          color: cardText,
          borderBottom: `${cardBorderWidth}px solid ${cardBorder}`,
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          boxSizing: 'border-box',
        });

        const leftCol = document.createElement('div');
        Object.assign(leftCol.style, {
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flex: '1',
          minWidth: '0',
        });

        if (cfg.iconUrl) {
          const img = document.createElement('img');
          img.src = cfg.iconUrl;
          img.alt = 'Logo';
          Object.assign(img.style, {
            width: '32px', height: '32px', borderRadius: '8px', objectFit: 'contain',
            flexShrink: '0', border: '1px solid rgba(226,232,240,0.6)', background: '#fff', padding: '2px', boxSizing: 'border-box',
          });
          leftCol.appendChild(img);
        } else {
          const icon = document.createElement('div');
          Object.assign(icon.style, {
            width: '32px', height: '32px', borderRadius: '8px', background: allowBg,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0', color: allowColor,
          });
          icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
          leftCol.appendChild(icon);
        }

        const bannerText = document.createElement('div');
        Object.assign(bannerText.style, { fontSize: '13px', lineHeight: '1.4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        bannerText.innerHTML = `<strong>${escapeHtml(cfg.title || DEFAULT_TITLE)}</strong>: <span style="opacity: 0.85;">${escapeHtml(cfg.body || '')}</span>`;
        leftCol.appendChild(bannerText);
        banner.appendChild(leftCol);

        const rightCol = document.createElement('div');
        Object.assign(rightCol.style, { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: '0' });

        const allowBtn = document.createElement('button');
        allowBtn.dataset.action = 'accept';
        Object.assign(allowBtn.style, {
          border: '0', padding: '7px 16px', borderRadius: `${allowRadius}px`,
          background: allowBg, color: allowColor, fontWeight: '700', fontSize: '12.5px', cursor: 'pointer',
        });
        allowBtn.textContent = cfg.acceptText || DEFAULT_ACCEPT;
        rightCol.appendChild(allowBtn);

        const dismissBtn = document.createElement('button');
        dismissBtn.dataset.action = 'decline';
        Object.assign(dismissBtn.style, {
          border: `1px solid ${declineBorder}`, padding: '7px 14px', borderRadius: `${declineRadius}px`,
          background: declineBg, color: declineColor, fontWeight: '600', fontSize: '12.5px', cursor: 'pointer',
        });
        dismissBtn.textContent = cfg.declineText || DEFAULT_DECLINE;
        rightCol.appendChild(dismissBtn);

        banner.appendChild(rightCol);
        root.appendChild(banner);
      } else {
        const card = document.createElement('div');
        Object.assign(card.style, {
          background:   cardBg,
          color:        cardText,
          borderRadius: `${cardRadius}px`,
          border:       cardBorderWidth > 0 ? `${cardBorderWidth}px solid ${cardBorder}` : 'none',
          boxShadow:    cardShadow,
          padding:      '18px',
          width:        '340px',
          maxWidth:     'calc(100vw - 32px)',
          position:     'relative',
          boxSizing:    'border-box',
          pointerEvents: 'auto',
        });
        root.appendChild(card);

        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '12px', alignItems: 'flex-start' });
        card.appendChild(row);

        if (cfg.iconUrl) {
          const img = document.createElement('img');
          img.src = cfg.iconUrl;
          img.alt = 'Brand Logo';
          Object.assign(img.style, {
            width: '40px',
            height: '40px',
            borderRadius: '12px',
            objectFit: 'contain',
            flexShrink: '0',
            border: '1px solid rgba(226, 232, 240, 0.6)',
            background: '#ffffff',
            padding: '2px',
            boxSizing: 'border-box',
          });
          row.appendChild(img);
        } else {
          const iconBox = document.createElement('div');
          Object.assign(iconBox.style, {
            width: '40px', height: '40px', borderRadius: '12px',
            background: allowBg,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0',
            color: allowColor,
          });
          iconBox.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3">' +
            '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
            '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>' +
            '</svg>';
          row.appendChild(iconBox);
        }

        const textCol = document.createElement('div');
        Object.assign(textCol.style, { flex: '1', minWidth: '0' });
        row.appendChild(textCol);

        const titleEl = document.createElement('div');
        Object.assign(titleEl.style, {
          fontWeight: '800', color: cardText, fontSize: '14.5px', lineHeight: '1.3',
        });
        titleEl.textContent = cfg.title ?? DEFAULT_TITLE;
        textCol.appendChild(titleEl);

        const bodyEl = document.createElement('div');
        Object.assign(bodyEl.style, {
          color: cardText, opacity: '0.8', fontSize: '12px', lineHeight: '1.5', marginTop: '4px',
        });
        bodyEl.textContent = cfg.body ?? '';
        textCol.appendChild(bodyEl);

        // Close 'x' button in header
        const closeBtn = document.createElement('button');
        closeBtn.dataset.action = 'decline';
        closeBtn.setAttribute('aria-label', 'Close');
        Object.assign(closeBtn.style, {
          background: 'transparent',
          border: '0',
          color: cardText,
          opacity: '0.45',
          fontSize: '16px',
          cursor: 'pointer',
          padding: '0 4px',
          lineHeight: '1',
          transition: 'opacity 0.15s ease',
        });
        closeBtn.onmouseenter = () => { closeBtn.style.opacity = '0.9'; };
        closeBtn.onmouseleave = () => { closeBtn.style.opacity = '0.45'; };
        closeBtn.innerHTML = '✕';
        row.appendChild(closeBtn);

        const buttons = document.createElement('div');
        Object.assign(buttons.style, { display: 'flex', gap: '8px', marginTop: '14px' });
        card.appendChild(buttons);

        const acceptBtn = document.createElement('button');
        acceptBtn.dataset.action = 'accept';
        Object.assign(acceptBtn.style, {
          flex: '1', border: '0', padding: '9px 14px', borderRadius: `${allowRadius}px`,
          background: allowBg, color: allowColor, fontWeight: '700', fontSize: '13px', cursor: 'pointer',
          boxShadow: '0 4px 12px ' + allowBg + '40',
        });
        acceptBtn.textContent = cfg.acceptText ?? DEFAULT_ACCEPT;
        buttons.appendChild(acceptBtn);

        const declineBtn = document.createElement('button');
        declineBtn.dataset.action = 'decline';
        Object.assign(declineBtn.style, {
          flex: '1', border: `1px solid ${declineBorder}`, padding: '9px 14px', borderRadius: `${declineRadius}px`,
          background: declineBg, color: declineColor, fontWeight: '700', fontSize: '13px', cursor: 'pointer',
        });
        declineBtn.textContent = cfg.declineText ?? DEFAULT_DECLINE;
        buttons.appendChild(declineBtn);

        if ((cfg as any).showPoweredBy !== false) {
          const poweredBy = document.createElement('div');
          Object.assign(poweredBy.style, {
            marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(148, 163, 184, 0.15)',
            fontSize: '10.5px', textAlign: 'center', color: cardText, opacity: '0.6',
          });
          poweredBy.innerHTML = 'Powered by <strong style="color: #2563EB;">ReachBell</strong>';
          card.appendChild(poweredBy);
        }
      }

      document.body.appendChild(root);
      root.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const action = target.closest('button')?.dataset.action;
        if (action === 'accept' || action === 'decline') {
          root.remove();
          resolve(action === 'accept');
        } else if (isCenterModal && target === root) {
          root.remove();
          resolve(false);
        }
      });
    });
  }

  private warnOnce(message: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    // Surface ONE visible warning in production so integrators have
    // something to grep when push silently doesn't work.
    // eslint-disable-next-line no-console
    console.warn('[ReachBell]', message, err);
  }

  private log(...args: any[]): void {
    if (this.config?.debug) {
      // eslint-disable-next-line no-console
      console.log('[ReachBell]', ...args);
    }
  }
}

export const ReachBell = new ReachBellClient();

if (typeof window !== 'undefined') {
  // Don't clobber an existing instance — first SDK load wins. Theme +
  // plugin integrations that both ship the SDK end up sharing one client.
  if (!(window as any).ReachBell) {
    (window as any).ReachBell = ReachBell;
  }
}

export default ReachBell;
