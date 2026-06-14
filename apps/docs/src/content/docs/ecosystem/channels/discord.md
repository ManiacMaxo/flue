---
title: Discord
description: Receive verified Discord interactions and use a project-owned REST client.
---

## Add Discord

Run the Discord recipe through your coding agent:

```sh
flue add discord --print | codex
```

It installs `@flue/discord`, `@discordjs/rest`, and `discord-api-types`.
Discord does not publish an official JavaScript REST SDK;
`@discordjs/rest` is the dominant community-maintained client.

Set the application's interactions endpoint to:

```txt
https://example.com/channels/discord/interactions
```

`DISCORD_PUBLIC_KEY` verifies inbound Ed25519 signatures.
`DISCORD_APPLICATION_ID` constrains signed provider identity.
`DISCORD_BOT_TOKEN` authenticates outbound REST calls.

## Channel module

```ts title="src/channels/discord.ts"
import { REST } from '@discordjs/rest';
import { createDiscordChannel } from '@flue/discord';
import { defineTool, dispatch } from '@flue/runtime';
import type { APIInteractionResponse } from 'discord-api-types/v10';
import assistant from '../agents/assistant.ts';

export const client = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

export const channel = createDiscordChannel({
  publicKey: process.env.DISCORD_PUBLIC_KEY!,
  applicationId: process.env.DISCORD_APPLICATION_ID!,

  // Path: /channels/discord/interactions
  async interactions({ interaction }) {
    if (
      interaction.type !== 'command' ||
      interaction.data.name !== 'ask' ||
      !interaction.destination ||
      interaction.destination.type === 'private'
    ) {
      return {
        type: 4,
        data: { content: 'Unsupported interaction.', flags: 64 },
      } satisfies APIInteractionResponse;
    }

    await dispatch(assistant, {
      id: channel.conversationKey(interaction.destination),
      input: {
        type: 'discord.command.ask',
        interactionId: interaction.id,
        data: interaction.data,
      },
    });
    return {
      type: 4,
      data: { content: 'Your request was accepted.', flags: 64 },
    } satisfies APIInteractionResponse;
  },
});

export function postMessage(ref: { channelId: string }) {
  return defineTool({
    name: 'post_discord_message',
    description: 'Post to the Discord destination bound to this agent.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', minLength: 1 } },
      required: ['content'],
      additionalProperties: false,
    },
    async execute({ content }) {
      const result = (await client.post(`/channels/${ref.channelId}/messages`, {
        body: { content },
      })) as { id?: string };
      return JSON.stringify({ messageId: result.id });
    },
  });
}
```

PING/PONG is handled internally. Verified commands, autocomplete, components,
and modals use discriminated variants; unsupported verified interaction types
arrive as `type: 'unknown'`. Every application callback must return a Discord
interaction response or an ordinary Hono `Response`.

Some valid interactions, including modal submissions, may omit a durable
destination. Private-channel interactions can be acknowledged with their
short-lived interaction capability, but the bot client cannot post arbitrary
messages into those channels.

Keep `interaction.capabilities` and `interaction.raw` out of dispatched input,
model context, logs, and durable history. Bot-token posts are ordinary new
messages, not interaction follow-ups or guaranteed ephemeral responses.

The package-root `@discordjs/rest` import selects its Fetch-based web export in
Cloudflare Workers. This example keeps `discord-api-types` imports type-only so
the Worker bundle does not depend on its runtime route helpers. Use the
project's Worker secret bindings and verify the Worker build.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/discord.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

Discord interactions do not provide dependable redelivery after failures.
Claim interaction ids in application-owned storage when unique admission is
required.

See the [`@flue/discord` API reference](/docs/api/discord-channel/).
