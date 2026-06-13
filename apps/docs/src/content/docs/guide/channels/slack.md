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

Omitting `events` or `interactions` omits that route. The Events API supports
normalized `app_mention` and plain user `message` variants. Unsupported
verified events and interactions reach the callback as `type: 'unknown'`.
Slack URL verification is handled internally.

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
thread. Never copy a signed `response_url` from `interaction.raw` into
dispatched input or a model-facing tool.

Slack may retry failed or timed-out Events API deliveries. Claim `eventId` in
application-owned durable storage when duplicate admission is unacceptable.

See the [`@flue/slack` API reference](/docs/api/slack-channel/).
