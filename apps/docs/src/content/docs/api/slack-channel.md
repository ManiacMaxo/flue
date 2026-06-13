---
title: Slack Channel API
description: Reference for verified Slack HTTP ingress from @flue/slack.
lastReviewedAt: 2026-06-13
---

Import from `@flue/slack`.

## `createSlackChannel()`

```ts
function createSlackChannel<E extends Env = Env>(options: SlackChannelOptions<E>): SlackChannel<E>;
```

Creates one stateless, fixed-application, fixed-workspace Slack channel. At
least one of `events` or `interactions` is required. Callbacks are stored during
construction and run only after request verification and identity checks.

## `SlackChannelOptions`

```ts
interface SlackChannelOptions<E extends Env = Env> {
  signingSecret: string;
  appId: string;
  teamId: string;
  bodyLimit?: number;
  handlerTimeoutMs?: number;
  events?(input: { c: Context<E>; event: SlackEvent }): SlackHandlerResult;
  interactions?(input: { c: Context<E>; interaction: SlackInteraction }): SlackHandlerResult;
}
```

| Field              | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `signingSecret`    | Secret used for Slack request signatures.                    |
| `appId`            | Expected signed Slack application id.                        |
| `teamId`           | Expected workspace id. Org-wide installs are not supported.  |
| `bodyLimit`        | Maximum request body in bytes. Default: 1 MiB.               |
| `handlerTimeoutMs` | Handler deadline. Default: 2500; maximum: 2500.              |
| `events`           | Optional Events API callback. Omission removes `/events`.    |
| `interactions`     | Optional interactivity callback. Omission removes the route. |

```ts
type SlackHandlerResult =
  | void
  | JsonValue
  | SlackViewValidationResponse
  | Response
  | Promise<void | JsonValue | SlackViewValidationResponse | Response>;
```

Returning nothing produces an empty `200`. JSON-compatible values become JSON
responses. An ordinary Hono or Fetch `Response` passes through unchanged.

## `SlackChannel`

```ts
interface SlackChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: SlackThreadRef): string;
  parseConversationKey(id: string): SlackThreadRef;
}
```

Configured routes are declared as `POST /events` and
`POST /interactions`. With `channels/slack.ts`, they are served beneath
`/channels/slack` relative to the `flue()` mount.

## Events API

```ts
type SlackEvent =
  | SlackEventEnvelope<'app_mention', SlackAppMentionPayload>
  | SlackEventEnvelope<'message', SlackMessagePayload>
  | SlackUnknownEvent;
```

```ts
interface SlackEventEnvelope<TType extends string, TPayload> {
  type: TType;
  eventId: string;
  appId: string;
  teamId: string;
  retry?: { number: number; reason?: string };
  payload: TPayload;
  raw: unknown;
}
```

Unsupported verified events use `type: 'unknown'` and expose the original
`eventType`. Their `eventId` is optional because unsupported outer Events API
envelopes do not always include one. URL verification is handled internally
after the configured app and workspace identities are verified. Plain user
messages are normalized; message subtypes and bot messages are ignored.

## Interactions

```ts
type SlackInteraction = SlackActionEnvelope | SlackViewSubmissionEnvelope | SlackUnknownInteraction;
```

Action envelopes expose `type: 'action'`, trusted app/team/user identity,
`actionId`, optional `value`, channel and thread identity, the provider-native
action under `payload`, and the complete parsed body under `raw`.

View submissions expose `type: 'view_submission'`, `viewId`, `callbackId`,
optional `privateMetadata`, and provider values.

```ts
interface SlackViewValidationResponse {
  response_action: 'errors';
  errors: Record<string, string>;
}
```

`raw` may contain a signed `response_url`. Keep it out of dispatched input,
model context, logs, and durable history.

## Identity

```ts
interface SlackThreadRef {
  teamId: string;
  channelId: string;
  threadTs: string;
}
```

Conversation keys are canonical identifiers, not authorization capabilities.

## Errors

- `InvalidSlackConversationKeyError`
- `InvalidSlackInputError`, with structured `field`

Requests outside Slack's five-minute timestamp window are rejected. The package
does not deduplicate Events API retries.

See [Slack setup](/docs/guide/channels/slack/) for composition with the Slack
Web API and application-owned tools.
