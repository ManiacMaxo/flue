---
title: Shopify Channel API
description: Reference for verified Shopify webhook ingress from @flue/shopify.
lastReviewedAt: 2026-06-13
---

Import from `@flue/shopify`.

## Exports

```ts
export {
  createShopifyChannel,
  type ChannelRoute,
  type JsonValue,
  type ShopifyChannel,
  type ShopifyChannelOptions,
  type ShopifyHandlerResult,
  type ShopifyWebhookEvent,
  type ShopifyWebhookHandlerInput,
};
```

## `createShopifyChannel()`

```ts
function createShopifyChannel<E extends Env = Env>(
  options: ShopifyChannelOptions<E>,
): ShopifyChannel<E>;
```

Creates one stateless Shopify JSON webhook channel.

## `ShopifyChannelOptions`

```ts
interface ShopifyChannelOptions<E extends Env = Env> {
  clientSecret: string;
  previousClientSecret?: string;
  bodyLimit?: number;
  handlerTimeoutMs?: number;
  webhook(input: ShopifyWebhookHandlerInput<E>): ShopifyHandlerResult;
}
```

| Field                  | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `clientSecret`         | Current Shopify app client secret used for webhook HMACs.          |
| `previousClientSecret` | Optional previous secret accepted during rotation overlap.         |
| `bodyLimit`            | Maximum request-body size in bytes. Defaults to 1 MiB.             |
| `handlerTimeoutMs`     | Complete route deadline. Defaults to 4500 ms; maximum 4500 ms.     |
| `webhook`              | Receives every verified, structurally valid JSON webhook delivery. |

Configured secrets must be non-empty. `bodyLimit` must be a positive integer.
`handlerTimeoutMs` must be a positive integer no greater than 4500.

## Handler input

```ts
interface ShopifyWebhookHandlerInput<E extends Env = Env> {
  c: Context<E>;
  event: ShopifyWebhookEvent;
}
```

`c` is the authentic Hono context. The callback runs only after exact-body
HMAC verification, required-header validation, UTF-8 decoding, and JSON
parsing.

## `ShopifyWebhookEvent`

```ts
interface ShopifyWebhookEvent<TPayload extends JsonValue = JsonValue> {
  topic: string;
  shopDomain: string;
  apiVersion: string;
  webhookId: string;
  eventId?: string;
  triggeredAt?: string;
  name?: string;
  subTopic?: string;
  payload: TPayload;
  rawBody: string;
}
```

| Field         | Source                         | Meaning                                             |
| ------------- | ------------------------------ | --------------------------------------------------- |
| `topic`       | `X-Shopify-Topic`              | Provider topic such as `orders/create`.             |
| `shopDomain`  | `X-Shopify-Shop-Domain`        | Shop associated with the delivery.                  |
| `apiVersion`  | `X-Shopify-API-Version`        | Version used to serialize the payload.              |
| `webhookId`   | `X-Shopify-Webhook-Id`         | Delivery identity for application-owned dedupe.     |
| `eventId`     | `X-Shopify-Event-Id`           | Optional identity shared by causally related sends. |
| `triggeredAt` | `X-Shopify-Triggered-At`       | Optional provider timestamp metadata.               |
| `name`        | `X-Shopify-Name`               | Optional subscription name.                         |
| `subTopic`    | `X-Shopify-Sub-Topic`          | Optional opaque sub-topic metadata.                 |
| `payload`     | Losslessly parsed request body | Provider JSON with no universal topic schema.       |
| `rawBody`     | Exact decoded request body     | Original JSON text used for verification.           |

Topics remain open strings. A verified topic newer than the installed package
still reaches `webhook`.

Payload fields depend on topic, API version, and subscription field selection.
The package parses JSON with `lossless-json`: safe numeric literals remain
JavaScript numbers, while numeric literals outside the safe integer range are
represented by their exact decimal strings. Applications must validate the
fields they consume and should accept `string | number` for Shopify identifiers
that can exceed `Number.MAX_SAFE_INTEGER`. Do not convert an unsafe identifier
string to `number`.

Shopify signs the request body, not these delivery headers. Header values are
provider-supplied routing metadata rather than independent cryptographic or
authorization claims. The package does not expose a conversation-key helper or
universal resource key.

## Handler result

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ShopifyHandlerResult =
  | undefined
  | JsonValue
  | Response
  | Promise<undefined | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. A normal Hono or Fetch `Response` passes through unchanged.
Thrown callbacks, unsupported return values, and route timeouts produce an
empty `500`.

Non-2xx responses request Shopify redelivery. Shopify's total response deadline
is five seconds, so `handlerTimeoutMs` covers body receipt, verification,
parsing, and the callback and is capped at 4500. Timed-out work is not
cancelled and can continue executing.

## `ShopifyChannel`

```ts
interface ShopifyChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
}

interface ChannelRoute<E extends Env = Env> {
  readonly method: string;
  readonly path: string;
  readonly handler: Handler<E>;
}
```

`routes` contains one `POST /webhook` declaration. A file named
`channels/shopify.ts` is served at `POST /channels/shopify/webhook` relative to
the `flue()` mount.

## Verification

The route accepts `application/json` and requires non-empty:

- `X-Shopify-Hmac-Sha256`;
- `X-Shopify-Topic`;
- `X-Shopify-Shop-Domain`;
- `X-Shopify-API-Version`;
- `X-Shopify-Webhook-Id`.

The channel retains the exact request bytes and verifies base64 HMAC-SHA256
with `clientSecret`. If that fails and `previousClientSecret` is configured,
it tries the previous secret. Verification runs before JSON parsing or
application code.

Unsupported media types receive `415`; oversized bodies receive `413`;
missing, malformed, or invalid authentication receives `401`; malformed JSON
or required delivery metadata receives `400`.

Shopify supplies no signed webhook timestamp or protocol replay window.
Applications own replay policy, delivery-id persistence, deduplication, and
ordering.

## Delivery and application boundary

Shopify can duplicate or reorder deliveries and retries failures eight times
over four hours. Use `webhookId` for delivery deduplication. Use `eventId`, when
present, only to correlate deliveries caused by the same merchant action.

The channel supports JSON HTTPS webhooks, including mandatory
`customers/data_request`, `customers/redact`, and `shop/redact` topics. It does
not support XML delivery, EventBridge, Google Pub/Sub, or long-lived
transports.

App installation, OAuth, Admin API tokens, webhook registration, subscription
filters, secret-rotation orchestration, deduplication, persistence, compliance
business actions, outbound clients, and tools remain application concerns.

`@flue/shopify` uses Hono, standards-based Web Crypto, and `lossless-json`; it
does not depend on the Shopify SDK or `@flue/runtime`. See
[Shopify setup](/docs/ecosystem/channels/shopify/) for the project-owned Admin
GraphQL client and Node/workerd testing guidance.
