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

Creates one stateless Slack channel for a fixed application and workspace. At
least one handler is required.

## `SlackChannelOptions`

```ts
interface SlackChannelOptions<E extends Env = Env> {
  signingSecret: string;
  appId: string;
  teamId: string;
  bodyLimit?: number;
  handlerTimeoutMs?: number;
  events?(input: { c: Context<E>; payload: SlackEventsApiPayload }): SlackHandlerResult;
  interactions?(input: { c: Context<E>; payload: SlackInteractionPayload }): SlackHandlerResult;
  commands?(input: { c: Context<E>; payload: SlackSlashCommandPayload }): SlackHandlerResult;
}
```

| Field              | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `signingSecret`    | Secret used to verify Slack request signatures.               |
| `appId`            | Expected Slack application id.                                |
| `teamId`           | Expected workspace id. Org-wide installs are rejected.        |
| `bodyLimit`        | Maximum request body in bytes. Defaults to 1 MiB.             |
| `handlerTimeoutMs` | Handler deadline. Defaults to and may not exceed 2500 ms.     |
| `events`           | Events API handler. Omission removes `POST /events`.          |
| `interactions`     | Interactivity handler. Omission removes `POST /interactions`. |
| `commands`         | Slash-command handler. Omission removes `POST /commands`.     |

URL verification is handled internally. Other authenticated deliveries reach
the configured handler after applicable app, workspace, and installation
checks.

## Events API types

```ts
type SlackEventsApiPayload = SlackEventCallbackPayload | SlackAppRateLimitedPayload;

interface SlackEventCallbackPayload {
  token: string;
  team_id: string;
  enterprise_id?: string | null;
  context_team_id?: string;
  context_enterprise_id?: string | null;
  api_app_id: string;
  event: SlackEvent;
  type: 'event_callback';
  event_id: string;
  event_time: number;
  event_context?: string;
  is_ext_shared_channel?: boolean;
  authorizations?: SlackAuthorization[];
}
```

`SlackEvent` is re-exported from the official `@slack/types` package. Use
`payload.type` to narrow the outer delivery and `payload.event.type` or
`payload.event.subtype` to narrow the provider event. Retry headers remain
available through `c.req.header(...)`.

## Interaction types

```ts
type SlackInteractionPayload =
  | SlackBlockActionsPayload
  | SlackViewSubmissionPayload
  | SlackViewClosedPayload
  | SlackShortcutPayload
  | SlackMessageActionPayload
  | SlackBlockSuggestionPayload
  | SlackInteractiveMessagePayload
  | SlackInteractiveMessageSuggestionPayload
  | SlackDialogSubmissionPayload
  | SlackDialogSuggestionPayload
  | SlackWorkflowStepEditPayload;
```

These local types preserve Slack's JSON field names and nesting, including
legacy interactive messages, dialogs, suggestions, and the deprecated
Steps-from-Apps edit payload. Authenticated future interaction types are
forwarded at runtime even when the installed type version does not yet include
their discriminant.

## `SlackSlashCommandPayload`

Provider-native URL-encoded slash-command fields, including:

```ts
interface SlackSlashCommandPayload {
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  user_id: string;
  team_id: string;
  channel_id: string;
  api_app_id: string;
  user_name?: string;
  team_domain?: string;
  channel_name?: string;
  enterprise_id?: string;
  enterprise_name?: string;
  is_enterprise_install?: string;
  [key: string]: unknown;
}
```

## Handler results

```ts
type SlackHandlerResult =
  | void
  | JsonValue
  | SlackViewValidationResponse
  | Response
  | Promise<void | JsonValue | SlackViewValidationResponse | Response>;
```

Returning nothing produces an empty `200`. JSON-compatible values become JSON
responses. Hono and Fetch responses pass through unchanged.

```ts
interface SlackViewValidationResponse {
  response_action: 'errors';
  errors: Record<string, string>;
}
```

## `SlackChannel`

```ts
interface SlackChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: SlackThreadRef): string;
  parseConversationKey(id: string): SlackThreadRef;
}

interface SlackThreadRef {
  teamId: string;
  channelId: string;
  threadTs: string;
}
```

Configured routes are relative to the discovered channel namespace. For
`channels/slack.ts`, they are served beneath `/channels/slack` relative to the
`flue()` mount.

Conversation keys are canonical identifiers, not authorization capabilities.

## Errors

- `InvalidSlackConversationKeyError`
- `InvalidSlackInputError`, with structured `field`

The channel does not deduplicate Events API retries. See
[Slack](/docs/ecosystem/channels/slack/) for provider setup and composition
with the Slack Web API.
