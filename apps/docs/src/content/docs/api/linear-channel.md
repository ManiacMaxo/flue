---
title: Linear Channel API
description: Reference for verified Linear ingress from @flue/linear.
lastReviewedAt: 2026-06-13
---

Import from `@flue/linear`.

## `createLinearChannel()`

```ts
function createLinearChannel<E extends Env = Env>(
  options: LinearChannelOptions<E>,
): LinearChannel<E>;
```

Creates one stateless `POST /webhook` route.

## `LinearChannelOptions`

```ts
interface LinearChannelOptions<E extends Env = Env> {
  webhookSecret: string;
  organizationId?: string;
  webhookId?: string;
  bodyLimit?: number;
  handlerTimeoutMs?: number;
  webhook(input: LinearWebhookHandlerInput<E>): LinearHandlerResult;
}
```

| Field              | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `webhookSecret`    | Secret used to verify exact request bytes with HMAC-SHA256.        |
| `organizationId`   | Optional signed organization constraint. Mismatches receive `403`. |
| `webhookId`        | Optional signed webhook constraint. Mismatches receive `403`.      |
| `bodyLimit`        | Maximum request body. Default: 1 MiB.                              |
| `handlerTimeoutMs` | Application deadline. Default and maximum: 4.5 seconds.            |
| `webhook`          | Callback for every verified normalized delivery.                   |

```ts
type LinearHandlerResult = void | JsonValue | Response | Promise<void | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. An ordinary Hono or Fetch `Response` passes through.

## `LinearChannel`

```ts
interface LinearChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: LinearConversationRef): string;
  parseConversationKey(id: string): LinearConversationRef;
}
```

A file named `channels/linear.ts` serves
`POST /channels/linear/webhook` relative to the `flue()` mount.

Conversation keys are canonical identifiers, not authorization capabilities.

## Events

```ts
type LinearWebhookEvent =
  | LinearCommentEvent
  | LinearIssueEvent
  | LinearProjectEvent
  | LinearAgentSessionEvent
  | LinearUnknownEvent;
```

Known `type` values are `comment`, `issue`, `project`, and `agent_session`.
Unsupported verified resource types or actions use `type: 'unknown'`.

Known event envelopes expose:

```ts
interface LinearEventEnvelope<TType extends string, TAction extends string, TPayload> {
  type: TType;
  action: TAction;
  resourceType: string;
  organizationId: string;
  webhookId: string;
  webhookTimestamp: number;
  createdAt: string;
  deliveryId?: string;
  url?: string;
  actor?: LinearActorRef;
  updatedFrom?: unknown;
  payload: TPayload;
  raw: unknown;
}
```

`deliveryId` comes from the `Linear-Delivery` header. Linear signs the body,
not that transport header. `raw` is available only after signature and
timestamp verification.

Comment, issue, and project events use `create`, `update`, or `remove` actions.
Agent-session events use `created` or `prompted`.

## Agent sessions

```ts
interface LinearAgentSessionPayload {
  appUserId: string;
  oauthClientId: string;
  session: LinearAgentSessionRef;
  promptContext?: string;
  activity?: LinearAgentActivityRef;
  previousComments: readonly LinearCommentRef[];
  guidance: readonly unknown[];
}
```

`created` deliveries may contain `promptContext`, previous comments, and
guidance. `prompted` deliveries contain the new user activity when supplied by
Linear.

## Identity

```ts
type LinearConversationRef =
  | {
      type: 'issue';
      organizationId: string;
      issueId: string;
      threadCommentId?: string;
    }
  | {
      type: 'agent-session';
      organizationId: string;
      agentSessionId: string;
    };
```

`LinearIssueConversationRef` and `LinearAgentSessionConversationRef` are the
corresponding narrowed union members. Known events expose the narrowed
conversation type implied by their `type`.

Top-level comments omit `threadCommentId` and use the issue conversation.
Replies use their root comment id. Agent-session conversations use the session
id.

## Errors

- `InvalidLinearConversationKeyError`
- `InvalidLinearInputError`, with structured `field`

See [Linear setup](/docs/ecosystem/channels/linear/) for webhook and official SDK
composition.
