---
title: Discord Channel API
description: Reference for verified Discord HTTP interactions from @flue/discord.
lastReviewedAt: 2026-06-13
---

Import from `@flue/discord`.

## `createDiscordChannel()`

```ts
function createDiscordChannel<E extends Env = Env>(
  options: DiscordChannelOptions<E>,
): DiscordChannel<E>;
```

Creates one stateless, fixed-application HTTP interactions channel. The
callback is stored during construction and runs only after Ed25519 verification
and application identity checks.

## `DiscordChannelOptions`

```ts
interface DiscordChannelOptions<E extends Env = Env> {
  publicKey: string;
  applicationId: string;
  bodyLimit?: number;
  handlerTimeoutMs?: number;
  interactions(input: { c: Context<E>; interaction: DiscordInteraction }): DiscordHandlerResult;
}
```

| Field              | Description                                      |
| ------------------ | ------------------------------------------------ |
| `publicKey`        | 32-byte public key as 64 hexadecimal characters. |
| `applicationId`    | Expected signed Discord application id.          |
| `bodyLimit`        | Maximum request body in bytes. Default: 1 MiB.   |
| `handlerTimeoutMs` | Handler deadline. Default: 2500; maximum: 2500.  |
| `interactions`     | Receives every verified non-PING interaction.    |

```ts
type DiscordHandlerResult =
  | DiscordInteractionResponse
  | Response
  | Promise<DiscordInteractionResponse | Response>;

interface DiscordInteractionResponse {
  type: number;
  data?: JsonValue;
}
```

Discord requires an interaction response. Return provider wire-format JSON or
an ordinary Hono or Fetch `Response`. The runtime checks only JSON
compatibility; use `discord-api-types` for complete provider response types.

## `DiscordChannel`

```ts
interface DiscordChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: DiscordDestinationRef): string;
  parseConversationKey(id: string): DiscordDestinationRef;
}
```

`routes` contains one `POST /interactions` declaration. A file named
`channels/discord.ts` is served at `/channels/discord/interactions` relative to
the `flue()` mount.

## Interactions

```ts
type DiscordInteraction =
  | DiscordCommandInteraction
  | DiscordAutocompleteInteraction
  | DiscordComponentInteraction
  | DiscordModalInteraction
  | DiscordUnknownInteraction;
```

Known variants use `type: 'command'`, `type: 'autocomplete'`,
`type: 'component'`, or `type: 'modal'`. Each exposes:

```ts
interface DiscordInteractionEnvelope<TType extends string, TData> {
  type: TType;
  id: string;
  applicationId: string;
  user: { id: string };
  context?: number;
  destination?: DiscordDestinationRef;
  locale?: string;
  guildLocale?: string;
  authorizingIntegrationOwners?: {
    guildId?: string;
    userId?: string;
  };
  capabilities: { token: string };
  data: TData;
  raw: unknown;
}
```

Unsupported verified interaction types use `type: 'unknown'` and retain the
numeric `interactionType`. PING is handled internally and returns PONG without
invoking `interactions`.

`capabilities` and `raw` may contain the short-lived interaction token. Keep
them out of dispatched input, model context, logs, and durable history.

Command data includes the numeric application-command type, name, options, and
optional target or resolved data. Autocomplete preserves the provider options.
Component data includes the originating message. Modal data includes flattened
scalar or list field values in addition to the provider component tree.

## Identity

```ts
type DiscordDestinationRef =
  | {
      type: 'guild';
      guildId: string;
      channelId: string;
      channelKind: 'channel' | 'thread';
    }
  | {
      type: 'dm';
      channelId: string;
    }
  | {
      type: 'private';
      channelId: string;
    };
```

Discord may omit channel context for valid interactions, so `destination` is
optional. Private-channel identity does not grant bot-token posting access.
Conversation keys are canonical identifiers, not authorization capabilities.

## Errors

- `InvalidDiscordConversationKeyError`
- `InvalidDiscordInputError`, with structured `field`

The package does not apply an invented timestamp freshness window or
deduplicate interaction ids.

See [Discord setup](/docs/guide/channels/discord/) for composition with
`@discordjs/rest` and application-owned tools.
