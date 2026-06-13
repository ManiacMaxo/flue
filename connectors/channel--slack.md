---
{
  "category": "channel",
  "website": "https://slack.com"
}
---

# Add a Slack Channel to Flue

You are an AI coding agent adding verified Slack HTTP ingress and
application-owned Slack Web API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
whether the application needs Events API, interactivity, or both.

Install `@flue/slack` and Slack's official
`@slack/web-api@^8.0.0-rc.1` SDK with the project's package manager. Version 8
uses the standard Fetch API and explicitly supports Cloudflare Workers. Flue's
Cloudflare target enables the `nodejs_compat` flag required by the current
release candidate.

## Create the channel

Create `<source-dir>/channels/slack.ts`. Adapt the imported agent and dispatched
input to the application:

```ts
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

  // Enable this surface only when the application handles interactions.
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

Omitting `events` or `interactions` omits that route. Leave an unused surface
commented out rather than publishing an empty handler. If the user does not
need thread replies, replace or omit the example tool. Keep channel ids,
`response_url`, credentials, and arbitrary Slack API methods out of tool
arguments unless explicitly authorized.

For Cloudflare projects, follow existing Worker binding conventions for
secrets. Keep using the project-owned `WebClient`; do not replace
`@flue/slack` ingress ownership.

## Wire the agent

```ts
import { createAgent } from '@flue/runtime';
import { channel, replyInThread } from '../channels/slack.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [replyInThread(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and initializers.

## Credentials and verification

`SLACK_SIGNING_SECRET` verifies exact request bytes. `SLACK_APP_ID` and
`SLACK_TEAM_ID` constrain trusted inbound identity. `SLACK_BOT_TOKEN`
authenticates outbound Web API calls. Follow project secret conventions and
never invent values.

Run the project's typecheck and configured build. Generate local
`X-Slack-Signature` values from representative Events API and interaction
payloads. Test the URL verification handshake, timestamp rejection, identity
mismatch, `/channels/slack/events`, optional route omission, and default empty
`200`. Do not contact Slack.
