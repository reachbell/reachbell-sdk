# @reachbell/sdk

Official ReachBell SDK for web push notifications, email subscriptions, and user identification.

## Install

```bash
npm install @reachbell/sdk
```

## Quickstart

```js
import { ReachBell } from '@reachbell/sdk';

ReachBell.init({
  apiKey: 'rb_live_yourkey',
  apiUrl: 'https://api.reachbell.com',
  autoPrompt: true,
});

// After login, link the subscription to your user ID:
const r = await ReachBell.identify('user_42');
if (!r.ok) console.warn('identify failed:', r.reason);

// Apply tags for segmentation:
await ReachBell.tag(['premium', 'active']);
```

## API surface

| Method                        | Returns                       | Notes                                                                        |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `ReachBell.init(config)`      | `void`                        | Idempotent — second call is a no-op unless `force:true` is set.              |
| `ReachBell.prompt()`          | `Promise<SubscribeResult>`    | Shows the configured opt-in prompt, then subscribes if accepted.             |
| `ReachBell.identify(extId)`   | `Promise<ApiResult>`          | Links the subscription to your user ID.                                      |
| `ReachBell.tag(tags)`         | `Promise<ApiResult>`          | Adds tags to the subscription for segmentation.                              |
| `ReachBell.ready`             | `Promise<void>`               | Resolves once `init()` + bootstrap have settled (success or failure).        |

`ApiResult = { ok: boolean; reason?: string }`. Common reasons: `sdk_not_initialized`, `no_subscription`, `timed_out`, `network_error`, `server_<status>`.

## Service Worker

Copy `reachbell-sw.js` from your ReachBell dashboard into your site's root directory.

## Documentation

Full docs at [docs.reachbell.com](https://docs.reachbell.com).

## License

MIT © DotSpheres Technologies Pvt Ltd
