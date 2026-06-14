---
title: Slack
description: Receive verified Slack events and use the Slack Web API from application tools.
---

## Add Slack

Run the Slack recipe through your coding agent:

```sh
flue add slack --print | codex
```

It installs `@flue/slack` and Slack's official
`@slack/web-api@^8.0.0-rc.1` SDK. Version 8 uses Fetch and supports both Node
and Cloudflare Workers. The recipe creates `src/channels/slack.ts` with named
`channel` and `client` exports.

Configure only the surfaces your application uses:

```txt
https://example.com/channels/slack/events
https://example.com/channels/slack/interactions
https://example.com/channels/slack/commands
```

`SLACK_SIGNING_SECRET` verifies inbound bytes. `SLACK_APP_ID` and
`SLACK_TEAM_ID` constrain signed provider identity. `SLACK_BOT_TOKEN`
authenticates outbound Web API calls.

## Channel module

```ts title="src/channels/slack.ts"
import { defineTool, dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';
import assistant from '../agents/assistant.ts';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  appId: process.env.SLACK_APP_ID!,
  teamId: process.env.SLACK_TEAM_ID!,

  // Path: /channels/slack/events
  async events({ event }) {
    switch (event.type) {
      case 'app_mention': {
        const thread = {
          teamId: event.teamId,
          channelId: event.payload.channelId,
          threadTs: event.payload.threadTs ?? event.payload.messageTs,
        };
        await dispatch(assistant, {
          id: channel.conversationKey(thread),
          input: {
            type: 'slack.app_mention',
            eventId: event.eventId,
            text: event.payload.text,
          },
        });
        return;
      }
      default:
        return;
    }
  },

  // Enable only when this application handles interactivity.
  // Path: /channels/slack/interactions
  // async interactions({ interaction }) {
  //   return;
  // },

  // Enable only when this application handles slash commands.
  // Path: /channels/slack/commands
  // async commands({ c, command }) {
  //   return c.json({ response_type: 'ephemeral', text: `Received ${command.command}` });
  // },
});

export function replyInThread(ref: { channelId: string; threadTs: string }) {
  return defineTool({
    name: 'reply_in_slack_thread',
    description: 'Reply in the Slack thread bound to this agent.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      const result = await client.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text,
      });
      return JSON.stringify({ channel: result.channel, ts: result.ts });
    },
  });
}
```

Omitting `events`, `interactions`, or `commands` omits that route. The Events
API supports normalized `app_mention` and plain user `message` variants.
Interactivity supports actions, view submissions and closures, global and
message shortcuts, and block suggestions. Unsupported verified events and
interactions reach the callback as `type: 'unknown'`. Slack URL verification is
handled internally from its signed challenge; that request does not include app
or workspace identity fields.

For a view submission, return Slack's native validation body or an ordinary
Hono response. An empty callback result becomes an empty `200`.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import { channel, replyInThread } from '../channels/slack.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [replyInThread(channel.parseConversationKey(id))],
}));
```

The model selects message text; trusted code binds the workspace, channel, and
thread. Interaction and slash-command `capabilities` can contain short-lived
`triggerId`, `responseUrl`, and view response URL values. Use them only in
immediate trusted application code. Never place them in dispatch input, model
context, logs, or durable session data.

Slack may retry failed or timed-out Events API deliveries. Claim `eventId` in
application-owned durable storage when duplicate admission is unacceptable.
Every callback has a default and maximum 2.5-second deadline so Flue can respond
before Slack's three-second acknowledgement window.

See the [`@flue/slack` API reference](/docs/api/slack-channel/).
