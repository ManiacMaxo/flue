---
title: Telegram Channel API
description: Reference for verified Telegram Bot API ingress from @flue/telegram.
lastReviewedAt: 2026-06-13
---

Import from `@flue/telegram`.

## `createTelegramChannel()`

```ts
function createTelegramChannel<E extends Env = Env>(
  options: TelegramChannelOptions<E>,
): TelegramChannel<E>;
```

Creates one stateless `POST /webhook` route.

## `TelegramChannelOptions`

```ts
interface TelegramChannelOptions<E extends Env = Env> {
  secretToken: string;
  bodyLimit?: number;
  webhook(input: TelegramWebhookHandlerInput<E>): TelegramHandlerResult;
}
```

| Field         | Description                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| `secretToken` | The 1-256 character `secret_token` configured through Telegram `setWebhook`. |
| `bodyLimit`   | Maximum request body. Default: 1 MiB.                                         |
| `webhook`     | Callback for one verified normalized Update.                                  |

`secretToken` accepts only Telegram's documented `A-Z`, `a-z`, `0-9`, `_`, and
`-` characters. It is required by Flue even though Telegram makes the setting
optional.

```ts
type TelegramHandlerResult =
  | void
  | JsonValue
  | Response
  | Promise<void | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes the
webhook response body and may use Telegram's webhook-reply method format. An
ordinary Hono or Fetch `Response` passes through.

## `TelegramChannel`

```ts
interface TelegramChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: TelegramConversationRef): string;
  parseConversationKey(id: string): TelegramConversationRef;
}
```

A file named `channels/telegram.ts` serves
`POST /channels/telegram/webhook` relative to the `flue()` mount.

The channel does not persist or deduplicate `update_id` values. Conversation
keys are canonical identifiers, not authorization capabilities.

## Updates

```ts
type TelegramUpdate =
  | TelegramMessageUpdate
  | TelegramCallbackQueryUpdate
  | TelegramMessageReactionUpdate
  | TelegramMessageReactionCountUpdate
  | TelegramUnknownUpdate;
```

Known `type` values are `message`, `callback_query`, `message_reaction`, and
`message_reaction_count`. Every update exposes `updateId` and `raw`.
Unsupported verified variants use `type: 'unknown'` with `updateType` and
`payload`. `raw` may contain provider capabilities; do not dispatch or persist
it wholesale.

`TelegramMessageUpdate.kind` distinguishes:

- `message`
- `edited_message`
- `channel_post`
- `edited_channel_post`
- `business_message`
- `edited_business_message`
- `guest_message`

Message payloads expose normalized chat and sender references, text or caption,
the first leading bot command, topic identity, business or guest identifiers,
and detected media kinds.

## Identity

```ts
type TelegramConversationRef =
  | {
      type: 'chat';
      chatId: number;
      messageThreadId?: number;
      directMessagesTopicId?: number;
    }
  | {
      type: 'business-chat';
      businessConnectionId: string;
      chatId: number;
      messageThreadId?: number;
      directMessagesTopicId?: number;
    };
```

Regular and business chats remain separate because Telegram permits their chat
identifiers to overlap. Forum threads and direct-message topics are distinct
destinations and cannot both be set.

Guest messages omit `conversation`. Their
`capabilities.guestQueryId` is a short-lived reply capability, not durable
destination identity. Do not place capabilities in model context, logs,
durable session data, or conversation keys.

Callback queries expose a conversation only when Telegram includes an
accessible message. Inline callback queries do not define a durable chat
destination. Reaction updates use chat-level identity because their payloads do
not include thread identity.

## Errors

- `InvalidTelegramConversationKeyError`
- `InvalidTelegramInputError`, with structured `field`

See [Telegram setup](/docs/ecosystem/channels/telegram/) for webhook and grammY
composition.
