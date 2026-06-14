---
title: Notion Channel API
description: Reference for verified Notion webhook ingress from @flue/notion.
lastReviewedAt: 2026-06-13
---

Import from `@flue/notion`.

## Exports

```ts
export {
  createNotionChannel,
  type ChannelRoute,
  type JsonValue,
  type NotionChannel,
  type NotionChannelOptions,
  type NotionHandlerResult,
  type NotionKnownWebhookEvent,
  type NotionUnknownWebhookEvent,
  type NotionVerificationHandlerInput,
  type NotionWebhookPrincipal,
  type NotionWebhookEvent,
  type NotionWebhookHandlerInput,
};
```

## `createNotionChannel()`

```ts
function createNotionChannel<E extends Env = Env>(
  options: NotionChannelOptions<E>,
): NotionChannel<E>;
```

Creates one stateless Notion webhook channel. At least one of
`verificationToken` or `verification` is required. `webhook` is always
required.

## `NotionChannelOptions`

```ts
interface NotionChannelOptions<E extends Env = Env> {
  verificationToken?: string;
  workspaceId?: string;
  subscriptionId?: string;
  integrationId?: string;
  bodyLimit?: number;
  verification?(input: NotionVerificationHandlerInput<E>): NotionHandlerResult;
  webhook(input: NotionWebhookHandlerInput<E>): NotionHandlerResult;
}
```

| Field               | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `verificationToken` | Token supplied by Notion during endpoint setup and used as the HMAC key.     |
| `workspaceId`       | Optional fixed workspace constraint. Signed mismatches receive `403`.        |
| `subscriptionId`    | Optional fixed subscription constraint. Signed mismatches receive `403`.     |
| `integrationId`     | Optional fixed integration constraint. Signed mismatches receive `403`.      |
| `bodyLimit`         | Maximum request-body size. Defaults to 1 MiB.                                |
| `verification`      | Handles the initial unsigned verification-token request.                     |
| `webhook`           | Receives every structurally valid event after signature and identity checks. |

The constructor throws `TypeError` for missing handlers, an empty configured
token or identity, a non-function callback, or a non-positive body limit.

## Initial verification

```ts
interface NotionVerificationHandlerInput<E extends Env = Env> {
  c: Context<E>;
  verificationToken: string;
}
```

The initial setup request has no `X-Notion-Signature`. The channel accepts it
only when the JSON body is an object containing exactly one non-empty
`verification_token` field.

When `verificationToken` is configured, the channel returns an empty `200`
only when the received token matches; a mismatch returns `403`, and the
temporary `verification` callback is not invoked. Before a token is configured,
the `verification` callback receives the setup value and its result becomes the
response.

The verification callback is unauthenticated setup code. Store the token
outside the channel, then configure it as `verificationToken` for recurring
events. Signed events receive `503` while no verification token is configured.

## Recurring events

```ts
interface NotionWebhookHandlerInput<E extends Env = Env> {
  c: Context<E>;
  event: NotionWebhookEvent;
}
```

Recurring requests require `application/json` and
`X-Notion-Signature: sha256=<64 hexadecimal characters>`. The signature is
HMAC-SHA256 over the exact request bytes using `verificationToken`.
Authentication runs before JSON parsing or `webhook`.

Malformed signed payloads receive `400`. Missing, malformed, or changed
signatures receive `401`. Configured workspace, subscription, or integration
mismatches receive `403`. Oversized bodies receive `413`; unsupported media
types receive `415`.

## Handler result

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type NotionHandlerResult =
  | undefined
  | JsonValue
  | Response
  | Promise<undefined | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. A normal Hono or Fetch `Response` passes through unchanged.
Thrown callbacks and unsupported return values produce an empty `500`.

The package does not impose a handler deadline.

## `NotionChannel`

```ts
interface NotionChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
}

interface ChannelRoute<E extends Env = Env> {
  readonly method: string;
  readonly path: string;
  readonly handler: Handler<E>;
}
```

`routes` contains one `POST /webhook` declaration. A file named
`channels/notion.ts` is served at `POST /channels/notion/webhook` relative to
the `flue()` mount.

Notion has several unrelated resource families, so the package does not expose
conversation-key helpers. Applications define the page, database, data source,
comment, view, or file identity appropriate to their agent.

## `NotionWebhookEvent`

```ts
type NotionWebhookEvent = NotionKnownWebhookEvent | NotionUnknownWebhookEvent;
```

`NotionKnownWebhookEvent` is a union of the webhook payload types exported by
the installed official Notion SDK. Known values retain provider-native
snake-case fields:

- Comments: `comment.created`, `comment.deleted`, `comment.updated`
- Data sources: `data_source.content_updated`, `data_source.created`,
  `data_source.deleted`, `data_source.moved`, `data_source.schema_updated`,
  `data_source.undeleted`
- Databases: `database.content_updated`, `database.created`,
  `database.deleted`, `database.moved`, `database.schema_updated`,
  `database.undeleted`
- File uploads: `file_upload.completed`, `file_upload.created`,
  `file_upload.expired`, `file_upload.upload_failed`
- Pages: `page.content_updated`, `page.created`, `page.deleted`,
  `page.locked`, `page.moved`, `page.properties_updated`,
  `page.transcription_block.transcript_deleted`, `page.undeleted`,
  `page.unlocked`
- Views: `view.created`, `view.deleted`, `view.updated`

Known events include `id`, `timestamp`, `workspace_id`, `workspace_name`,
`subscription_id`, `integration_id`, `authors`, `attempt_number`,
`api_version`, `entity`, and event-specific `data` when the provider supplies
it.

```ts
interface NotionWebhookPrincipal {
  id: string;
  type: 'agent' | 'bot' | 'person';
}
```

`@flue/notion` widens the official SDK's current `authors` and optional
`accessible_by` declarations to include Notion's documented `agent` principal
type.

## Unknown event normalization

```ts
interface NotionUnknownWebhookEvent {
  type: 'unknown';
  eventType: string;
  id: string;
  timestamp: string;
  workspaceId: string;
  workspaceName: string;
  subscriptionId: string;
  integrationId: string;
  authors: NotionWebhookPrincipal[];
  accessibleBy?: NotionWebhookPrincipal[];
  attemptNumber: number;
  apiVersion: string;
  raw: unknown;
}
```

A structurally valid, signed event whose provider `type` is not represented by
the installed SDK, or whose `api_version` is newer than the installed SDK's
known versions, is normalized to `type: 'unknown'`. `eventType` preserves the
provider event type. The camel-case identity and delivery fields are copied
from the verified payload, and `raw` contains the complete parsed payload.

Unknown normalization does not accept an otherwise malformed event. The
provider payload must still include a non-empty event type, delivery id,
parseable timestamp, workspace, subscription, integration, valid authors,
positive integer attempt number, and API version.

## Delivery semantics

The channel exposes Notion's delivery `id` and `attempt_number` but does not
persist deduplication state or restore ordering. Resource and delivery ids are
identifiers, not authorization capabilities.

Webhook subscription creation, OAuth, installation and token storage,
resource-fetching policy, and outbound API tools remain application concerns.

See [Notion setup](/docs/ecosystem/channels/notion/) for initial verification,
official client composition, application-owned page identity, and Cloudflare
runtime notes.
