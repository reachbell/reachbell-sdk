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
| `ReachBell.unsubscribe()`     | `Promise<ApiResult>`          | Removes this browser's push subscription and forgets the stored token. The opt-out is remembered, so later page loads don't re-subscribe silently; only `prompt()` subscribes again. It also forgets the stored `identify()` user. Returns `sw_not_registered` if no service worker registration can be found (the opt-out is still recorded and a mounted bell widget updates). |
| `ReachBell.identify(extId, { hash }?)` | `Promise<ApiResult>` | Links the subscription to your user ID. Pass `null` on logout to unlink it. `hash` is the identity-verification HMAC for verified IDs (e.g. Shopify customers); it is stored and resent with that ID. See [Identity](#identity) below. |
| `ReachBell.tag(tags)`         | `Promise<ApiResult>`          | Adds tags to the subscription for segmentation.                              |
| `ReachBell.showToast(opts)`   | `() => void`                  | In-page toast (no push permission needed). Returns a dismiss fn.             |
| `ReachBell.showBanner(opts)`  | `() => void`                  | Sticky top/bottom announcement bar. Returns a dismiss fn.                    |
| `ReachBell.showNotificationCenter(opts)` | `() => void`       | Floating bell widget + recent-notifications dropdown.                        |
| `ReachBell.recordNotification(item)` | `void`                 | Add an item to the local notification-center history.                        |
| `ReachBell.attachUtmTagger(utm)` | `void`                     | Auto-append UTM params to outbound link clicks for attribution.              |
| `ReachBell.ready`             | `Promise<void>`               | Resolves once `init()` + bootstrap have settled (success or failure). Returning subscribers are re-synced before it resolves. |

With `autoPrompt: true` the SDK shows the dashboard prompt on its own, using the dashboard's delay, scroll depth and frequency settings. A `native` prompt waits for the visitor's first click or key press, because browsers ignore permission requests that are not triggered by the visitor. Banner, toast and notification-center widgets appear only when they are switched on in the dashboard.

`SubscribeResult = { success: boolean; token?: string; reason?: string; identityDropped?: true }`. Reasons: `sdk_not_initialized`, `push_not_supported`, `not_ready`, `permission_denied`, `user_declined_soft_prompt`, `sw_not_active`, `sw_register_failed_<name>`, `push_subscribe_failed_<name>`, `subscribe_failed_<status>`, `subscribe_rejected` (the API answered `success:false` without a reason), `identity_hash_invalid` (the stored ID's hash was rejected and the retry without it also failed), `superseded` (a `force` re-init replaced the config mid-subscribe; nothing was registered), `timed_out`, `network_error`.

`identityDropped: true` is set on a **successful** subscribe when the stored user ID was rejected with `identity_hash_invalid` (e.g. the identity secret was rotated): the subscription is active but anonymous, and the stored ID was cleared. Call `identify()` again with a fresh hash. With `debug: true` the SDK also logs a `console.warn`.

`ApiResult = { ok: boolean; reason?: string }`. Reasons: `sdk_not_initialized`, `no_subscription`, `external_id_required`, `identity_hash_invalid`, `subscriber_not_found`, `token_required`, `rejected` (the API answered `success:false` without a reason), `sw_not_registered`, `unsubscribe_failed_<name>`, `timed_out`, `network_error`, `server_<status>`. API-side reasons are passed through as-is.

### Identity

- The newest `identify()` call wins. Its ID (and `hash`) replaces any stored one — including when there is no subscription yet: that call returns `{ ok: false, reason: 'no_subscription' }`, but the ID is remembered and sent with the next subscribe, so the subscription is never linked to an earlier user.
- If the identify request fails for a network or server reason, the new ID stays stored and is resent (and verified by the API) on the next `POST /subscribers`. If the API rejects the hash (`identity_hash_invalid`), the stored ID is cleared rather than falling back to the previous user.
- `identify(null)` always forgets the stored ID locally. If the `/subscribers/unidentify` call fails (offline, `server_<status>`), it returns `{ ok: false, reason }` and the server-side link stays until a later `identify(null)` succeeds — retry it if you need the unlink to be guaranteed.
- `unsubscribe()` also forgets the stored ID.

### Storage

Token, endpoint, identity and the unsubscribe opt-out are stored in `localStorage`, keyed by API key (`reachbell_token:<apiKey>`, `reachbell_identity:<apiKey>`, `reachbell_opted_out:<apiKey>`, …). When `localStorage` is unavailable (Safari private mode, blocked storage) the token and opt-out are kept in memory, so `unsubscribe()` still sticks for the rest of the page session. Because the keys include the API key, rotating the public key starts with fresh local state (the earlier opt-out and identity are not carried over).

## Service Worker

The service worker must be served from your site's root (`/reachbell-sw.js`). Create it with:

```bash
npx @reachbell/sdk
```

This writes `reachbell-sw.js` into `public/` (or the current folder), loading the latest worker from ReachBell. Pass `swPath` to `init()` if you serve it somewhere else. The SDK tells the worker which API to report delivery and clicks to. That is https://api.reachbell.com unless you pass `apiUrl`, which you only need for a staging or self-hosted API.

Script-tag builds can load `@reachbell/sdk/iife` (`dist/index.iife.js`), which sets `window.ReachBell`.

## Documentation

Full docs at [docs.reachbell.com](https://docs.reachbell.com).

## License

MIT © DotSpheres Technologies Pvt Ltd
