# `@flue/discord`

Verified Discord HTTP interactions ingress for Flue applications.

```ts
import { createDiscordChannel } from '@flue/discord';
import { InteractionResponseType } from 'discord-api-types/v10';

export const channel = createDiscordChannel({
  publicKey: process.env.DISCORD_PUBLIC_KEY!,
  applicationId: process.env.DISCORD_APPLICATION_ID!,

  // Path: /channels/discord/interactions
  async interactions({ interaction }) {
    await handleInteraction(interaction);
    return {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content: 'Accepted.', flags: 64 },
    };
  },
});
```

Place this export in `channels/discord.ts`. Flue discovers it and serves
`POST /channels/discord/interactions` relative to the `flue()` mount.

The package verifies Ed25519 signatures over exact request bytes, handles
PING/PONG internally, checks the signed application id, and normalizes commands,
components, modals, and unknown verified interaction types. Application
callbacks return Discord wire-format JSON or an ordinary Hono response.

This package does not include an outbound Discord client, response builder, or
model tools. Run `flue add discord` to generate editable project code using
`@discordjs/rest`, `discord-api-types`, and application-owned
`defineTool(...)` values.

Conversation keys identify guild channels, guild threads, and bot DMs. They are
not authorization capabilities. The package is stateless and does not
deduplicate interaction ids.
