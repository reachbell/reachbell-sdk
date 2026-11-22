# @reachbell/sdk

Official ReachBell SDK for web push notifications, user identification, and in-page widgets (toasts, banners, notification center). One package — no REST calls to write; the dashboard handles sending and campaigns.

## Install

```bash
npm install @reachbell/sdk
```

## Quickstart

```js
import { ReachBell } from '@reachbell/sdk';

ReachBell.init({
  apiKey: 'rb_live_yourkey',
  autoPrompt: true,
});

await ReachBell.ready;

// identify() and tag() need a subscription, so call them after prompt()
// succeeds, or on later page loads for visitors who already subscribed:
const sub = await ReachBell.prompt();
if (sub.success) {
  await ReachBell.identify('user_42');
  await ReachBell.tag(['premium', 'active']);
}
```

## API surface

| Method                        | Returns                       | Notes                                                                        |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `ReachBell.init(config)`      | `void`                        | Idempotent — second call is a no-op unless `force:true` is set. Each (re)init dispatches a `reachbell:init` event on `window`. |
| `ReachBell.prompt()`          | `Promise<SubscribeResult>`    | Shows the configured opt-in prompt, then subscribes if accepted. Returns `permission_denied` straight away when the browser has blocked notifications, and re-uses an existing subscription when permission is already granted. |
| `ReachBell.unsubscribe()`     | `Promise<ApiResult>`          | Removes this browser's push subscription and forgets the stored token. The opt-out is remembered, so later page loads don't re-subscribe silently; only `prompt()` subscribes again. Returns `sw_not_registered` if no service worker registration can be found. |
| `ReachBell.identify(extId, { hash }?)` | `Promise<ApiResult>` | Links the subscription to your user ID. Pass `null` on logout to unlink it. `hash` is the identity-verification HMAC for verified IDs (e.g. Shopify customers); it is stored and resent with that ID. |
| `ReachBell.tag(tags)`         | `Promise<ApiResult>`          | Adds tags to the subscription for segmentation.                              |
| `ReachBell.showToast(opts)`   | `() => void`                  | In-page toast (no push permission needed). Returns a dismiss fn.             |
| `ReachBell.showBanner(opts)`  | `() => void`                  | Sticky top/bottom announcement bar. Returns a dismiss fn.                    |
| `ReachBell.showNotificationCenter(opts)` | `() => void`       | Floating bell widget + recent-notifications dropdown.                        |
| `ReachBell.recordNotification(item)` | `void`                 | Add an item to the local notification-center history.                        |
| `ReachBell.attachUtmTagger(utm)` | `void`                     | Auto-append UTM params to outbound link clicks for attribution.              |
| `ReachBell.ready`             | `Promise<void>`               | Resolves once `init()` + bootstrap have settled (success or failure). Returning subscribers are re-synced before it resolves. |

With `autoPrompt: true` the SDK shows the dashboard prompt on its own, using the dashboard's delay, scroll depth and frequency settings. A `native` prompt waits for the visitor's first click or key press, because browsers ignore permission requests that are not triggered by the visitor. Banner, toast and notification-center widgets appear only when they are switched on in the dashboard.

`SubscribeResult` reasons: `sdk_not_initialized`, `push_not_supported`, `not_ready`, `permission_denied`, `user_declined_soft_prompt`, `sw_not_active`, `sw_register_failed_<name>`, `push_subscribe_failed_<name>`, `subscribe_failed_<status>`, `timed_out`, `network_error`.

`ApiResult = { ok: boolean; reason?: string }`. Common reasons: `sdk_not_initialized`, `no_subscription`, `timed_out`, `network_error`, `server_<status>`.

## Service Worker

The service worker must be served from your site's root (`/reachbell-sw.js`). Create it with:

```bash
npx reachbell
```

This writes `reachbell-sw.js` into `public/` (or the current folder), loading the latest worker from ReachBell. Pass `swPath` to `init()` if you serve it somewhere else. The SDK tells the worker which API to report delivery and clicks to. That is https://api.reachbell.com unless you pass `apiUrl`, which you only need for a staging or self-hosted API.

Script-tag builds can load `@reachbell/sdk/iife` (`dist/index.iife.js`), which sets `window.ReachBell`.

## Documentation

Full docs at [docs.reachbell.com](https://docs.reachbell.com).

## License

MIT © DotSpheres Technologies Pvt Ltd
