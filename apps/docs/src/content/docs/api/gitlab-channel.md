---
title: GitLab Channel API
description: Reference for verified GitLab webhook ingress from @flue/gitlab.
---

Import from `@flue/gitlab`.

## `createGitLabChannel()`

```ts
function createGitLabChannel<E extends Env = Env>(
  options: GitLabChannelOptions<E>,
): GitLabChannel<E>;
```

Creates one stateless `POST /webhook` route for GitLab project or group webhooks.
The callback is stored during construction and runs only after request verification.

## `GitLabChannelOptions`

```ts
interface GitLabChannelOptions<E extends Env = Env> {
  signingToken?: string;
  secretToken?: string;
  bodyLimit?: number;
  webhook(input: GitLabWebhookHandlerInput<E>): GitLabHandlerResult;
}
```

| Field          | Description                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `signingToken` | GitLab 19.0+ signing token in `whsec_<base64>` form. Preferred for new webhooks.                   |
| `secretToken`  | Legacy token checked against `X-Gitlab-Token`. Use for older GitLab versions or migration windows. |
| `bodyLimit`    | Maximum request body in bytes. Default: 1 MiB.                                                     |
| `webhook`      | Receives every verified GitLab project or group webhook payload.                                   |

At least one of `signingToken` or `secretToken` is required. If a request carries
`webhook-signature` and `signingToken` is configured, the signature path is used;
a failed signature receives `401` and does not fall back to `secretToken`.

```ts
type GitLabHandlerResult = void | JsonValue | Response | Promise<void | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a JSON
response. An ordinary Hono or Fetch `Response` passes through unchanged. A thrown
callback falls through to Hono's framework error handler.

## `GitLabChannel`

```ts
interface GitLabChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: GitLabConversationRef): string;
  parseConversationKey(id: string): GitLabConversationRef;
}
```

`routes` contains one `POST /webhook` declaration used by discovered channel
routing. A file named `channels/gitlab.ts` is served at
`/channels/gitlab/webhook` relative to the `flue()` mount.

Conversation keys are canonical identifiers, not authorization capabilities.
They cover GitLab issues and merge requests by instance, project id, and iid.

## Deliveries

Every verified delivery reaches `webhook` as a `GitLabWebhookDelivery`. The
package does not normalize, rename, or enumerate a fixed set of events: the
parsed JSON object is forwarded with GitLab's own field names and nesting.

```ts
interface GitLabWebhookDelivery {
  eventName: string;
  payload: GitLabWebhookPayload;
  deliveryId?: string;
  idempotencyKey?: string;
  eventUuid?: string;
  webhookUuid?: string;
  instance?: string;
  signatureTimestamp?: string;
}
```

| Field                | Description                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `eventName`          | `X-Gitlab-Event`, such as `Note Hook`, `Push Hook`, or `Merge Request Hook`. |
| `payload`            | GitLab's verified JSON payload.                                              |
| `deliveryId`         | Standard Webhooks `webhook-id`, when supplied. Use for deduplication.        |
| `idempotencyKey`     | `Idempotency-Key`, available on newer deliveries and retries.                |
| `eventUuid`          | `X-Gitlab-Event-UUID`; recursive webhooks can share this value.              |
| `webhookUuid`        | `X-Gitlab-Webhook-UUID`, identifying the configured webhook.                 |
| `instance`           | `X-Gitlab-Instance`, identifying the sender instance.                        |
| `signatureTimestamp` | `webhook-timestamp`, when signature verification was used.                   |

## `GitLabWebhookPayload`

```ts
interface GitLabWebhookPayload {
  [key: string]: unknown;
  object_kind?: string;
  event_name?: string;
  event_type?: string;
  object_attributes?: Record<string, unknown>;
}
```

GitLab does not publish an authoritative TypeScript package for webhook bodies.
The channel therefore uses a broad provider-native JSON object and forwards
verified payloads unmodified. Applications narrow on GitLab's own fields, such
as `object_kind`, `event_name`, `event_type`, and nested `object_attributes`.

Choosing which events to act on is application policy: subscribe to the minimum
set in GitLab and branch in the handler. The package rejects malformed transport
or authentication, not valid GitLab event families it does not model.

## Verification

Signed webhooks verify the exact request bytes with GitLab's Standard Webhooks
headers:

- `webhook-id`
- `webhook-timestamp`
- `webhook-signature`

The signature is HMAC-SHA256 over:

```txt
{webhook-id}.{webhook-timestamp}.{rawBody}
```

The channel accepts any matching space-separated `v1,<base64>` signature and
rejects timestamps outside a five-minute window. Legacy webhooks verify
`X-Gitlab-Token` when `secretToken` is configured. Ingress is JSON-only.

## Identity

```ts
type GitLabConversationRef =
  | {
      type: 'issue';
      instance: string;
      projectId: number;
      iid: number;
    }
  | {
      type: 'merge-request';
      instance: string;
      projectId: number;
      iid: number;
    };
```

`projectId` is GitLab's numeric project id. `iid` is the project-scoped issue or
merge request iid used by GitLab REST routes.

## Errors

- `InvalidGitLabConversationKeyError`
- `InvalidGitLabInputError`, with structured `field`

See [GitLab setup](/docs/ecosystem/channels/gitlab/) for webhook configuration
and application-owned Fetch client composition.
