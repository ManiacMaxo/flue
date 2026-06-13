# `@flue/discord`

Verified Discord HTTP interactions ingress for Flue applications.

```ts
import { createDiscordChannel } from '@flue/discord';
import type { APIInteractionResponse } from 'discord-api-types/v10';

export const channel = createDiscordChannel({
  publicKey: process.env.DISCORD_PUBLIC_KEY!,
  applicationId: process.env.DISCORD_APPLICATION_ID!,

  // Path: /channels/discord/interactions
  async interactions({ interaction }) {
    await handleInteraction(interaction);
    return {
      type: 4,
      data: { content: 'Accepted.', flags: 64 },
    } satisfies APIInteractionResponse;
  },
});
```

Place this export in `channels/discord.ts`. Flue discovers it and serves
`POST /channels/discord/interactions` relative to the `flue()` mount.

The package verifies Ed25519 signatures over exact request bytes, handles
PING/PONG internally, checks the signed application id, and normalizes commands,
autocomplete, components, modals, and unknown verified interaction types.
Application callbacks return Discord wire-format JSON or an ordinary Hono
response.

This package does not include an outbound Discord client, response builder, or
model tools. Run `flue add discord` to generate editable project code using
`@discordjs/rest`, `discord-api-types`, and application-owned
`defineTool(...)` values.

Conversation keys identify guild destinations, bot DMs, and private-channel
contexts when Discord supplies a channel. Some valid interactions have no
destination. Conversation keys are not authorization capabilities. The package
is stateless and does not deduplicate interaction ids.
