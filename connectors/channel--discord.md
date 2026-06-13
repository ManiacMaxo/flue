---
{
  "category": "channel",
  "website": "https://discord.com"
}
---

# Add a Discord Channel to Flue

You are an AI coding agent adding verified Discord HTTP interactions and
application-owned Discord REST behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
the interaction commands the application supports.

Install `@flue/discord`, `@discordjs/rest`, and `discord-api-types`. Discord
does not publish an official JavaScript REST SDK; `@discordjs/rest` is the
dominant community-maintained REST client. Do not add Discord Gateway or a
long-lived bot connection for outbound REST calls.

## Create the channel

Create `<source-dir>/channels/discord.ts`. Adapt the imported agent, command
name, dispatched input, and immediate response:

```ts
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
    description: 'Post a message to the Discord destination bound to this agent.',
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

Discord interactions require a provider response; do not rely on an empty
acknowledgement. PING/PONG is handled by `@flue/discord`. Keep interaction
capabilities and raw payloads out of dispatched input and tools. Some valid
interactions have no durable destination, and private-channel interactions
cannot be used as arbitrary bot-token message destinations.

The package-root `@discordjs/rest` import selects its Fetch-based web export in
Cloudflare Workers. Keep `discord-api-types` imports type-only so the Worker
bundle does not depend on its runtime route helpers. Follow the project's
Worker secret binding convention and verify the actual Worker build. Do not
expose arbitrary channel ids, routes, or bot tokens to the model.

## Wire the agent

```ts
import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/discord.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and initializers.

## Credentials and verification

`DISCORD_PUBLIC_KEY` verifies inbound Ed25519 signatures.
`DISCORD_APPLICATION_ID` constrains inbound identity.
`DISCORD_BOT_TOKEN` authenticates outbound REST calls. Follow project secret
conventions and never invent values.

Run the project's typecheck and configured Flue build. Generate a local Ed25519
key pair and signed PING and command payloads. Test invalid signatures,
application-id mismatch, PING/PONG, `/channels/discord/interactions`, the typed
command response, and the deferred channel-agent import cycle. Do not contact
Discord.
