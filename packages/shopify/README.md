# `@flue/shopify`

Verified Shopify JSON webhook ingress for Flue.

The package exposes one fixed `POST /webhook` route and verifies Shopify's
base64 HMAC-SHA256 over the exact request bytes before parsing the payload or
calling application code.

```ts
import { createShopifyChannel } from '@flue/shopify';

export const channel = createShopifyChannel({
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET!,

  // Path: /channels/shopify/webhook
  webhook({ event }) {
    if (event.topic === 'orders/create') {
      // Validate the topic fields you consume, then dispatch application work.
    }
  },
});
```

Place this export in `channels/shopify.ts`. Flue discovers it and serves
`POST /channels/shopify/webhook` relative to the `flue()` mount.

The callback receives topic, shop, API-version, delivery, and optional causal
metadata together with parsed JSON and the exact verified body. Payload fields
vary by topic, API version, and subscription field selection, so the package
does not publish a false closed payload union. Numeric literals outside
JavaScript's safe range are represented as strings rather than silently
rounding Shopify's 64-bit identifiers.

Returning no value or a JSON-compatible value acknowledges the delivery with
`200`. A returned Hono or Fetch `Response` passes through unchanged. Shopify
retries non-2xx responses. Complete route processing, including body receipt,
verification, parsing, and the application callback, defaults to a 4500ms
deadline so Flue can respond before Shopify's five-second total delivery
deadline.

Shopify does not sign a timestamp or provide a replay window, does not
guarantee ordering, and can redeliver events. Persist `event.webhookId` for
application-owned deduplication. Shopify's HMAC covers the body rather than the
delivery headers; header metadata is routing context, not an authorization
capability.

App installation, OAuth, access-token storage, webhook registration, compliance
business workflows, deduplication, and outbound Admin API behavior remain
application-owned.
