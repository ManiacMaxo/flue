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
least one of `events`, `interactions`, or `commands` is required. Callbacks are
stored during construction and run only after request verification and
applicable identity checks.

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
  commands?(input: { c: Context<E>; command: SlackSlashCommand }): SlackHandlerResult;
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
| `commands`         | Optional slash-command callback. Omission removes the route. |

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

Configured routes are declared as `POST /events`, `POST /interactions`, or
`POST /commands`. With `channels/slack.ts`, they are served beneath
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
from the signed challenge; Slack does not include app or workspace identity in
that payload. Plain user messages are normalized; message subtypes and bot
messages are ignored.

## Interactions

```ts
type SlackInteraction =
  | SlackActionEnvelope
  | SlackViewSubmissionEnvelope
  | SlackViewClosedEnvelope
  | SlackShortcutEnvelope
  | SlackMessageShortcutEnvelope
  | SlackBlockSuggestionEnvelope
  | SlackUnknownInteraction;
```

Action envelopes expose `type: 'action'`, trusted app/team/user identity,
`actionId`, optional `value`, provider container context, optional channel and
thread identity, the provider-native action under `payload`, and the complete
parsed body under `raw`. Actions originating from views do not require message
context.

View submissions expose `type: 'view_submission'`, `viewId`, `callbackId`,
optional `privateMetadata`, and provider values.

Global and message shortcuts expose their callback ids. View closures expose
`isCleared`. Block suggestions expose the action, block, and current input value
needed to return provider-native option JSON.

Some shortcut payloads do not include `api_app_id`. After signature
verification, the normalized `appId` is the channel's configured application
id; a supplied mismatched id is rejected.

```ts
interface SlackViewValidationResponse {
  response_action: 'errors';
  errors: Record<string, string>;
}
```

## Slash commands

```ts
interface SlackSlashCommand {
  type: 'slash_command';
  appId: string;
  teamId: string;
  enterpriseId?: string;
  channelId: string;
  channelName?: string;
  userId: string;
  userName?: string;
  command: string;
  text: string;
  capabilities: SlackInteractionCapabilities & {
    triggerId: string;
    responseUrl: string;
  };
  raw: unknown;
}
```

One `/commands` route can receive multiple configured Slack commands. Switch on
`command.command`. Return JSON for a provider-native response or use the Hono
context for plain text and explicit status control.

## Capabilities

```ts
interface SlackInteractionCapabilities {
  triggerId?: string;
  responseUrl?: string;
  responseUrls?: readonly {
    blockId: string;
    actionId: string;
    channelId: string;
    responseUrl: string;
  }[];
}
```

These are short-lived provider capabilities for immediate trusted application
use. Never place them, or equivalent values from `raw`, in dispatch input,
model context, logs, or durable history.

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
rejects org-wide installations and does not deduplicate Events API retries.

See [Slack setup](/docs/ecosystem/channels/slack/) for composition with the Slack
Web API and application-owned tools.
