---
title: Linear
description: Receive verified Linear resource and agent-session webhooks with a project-owned SDK client.
---

## Add Linear

Run the Linear recipe through your coding agent:

```sh
flue add linear --print | codex
```

It installs `@flue/linear` for verified ingress and the official
`@linear/sdk` for project-owned outbound API access. Linear uses that SDK in
its own Cloudflare Workers agent example with `nodejs_compat`, which Flue's
Cloudflare target already enables.

Set the webhook URL to:

```txt
https://example.com/channels/linear/webhook
```

## Channel module

```ts title="src/channels/linear.ts"
import { createLinearChannel, type LinearConversationRef } from '@flue/linear';
import { defineTool, dispatch } from '@flue/runtime';
import { LinearClient } from '@linear/sdk';
import assistant from '../agents/assistant.ts';

const organizationId = process.env.LINEAR_ORGANIZATION_ID;

export const client = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY!,
});

export const channel = createLinearChannel({
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,
  ...(organizationId ? { organizationId } : {}),

  // Path: /channels/linear/webhook
  async webhook({ event }) {
    switch (event.type) {
      case 'comment': {
        if (event.action !== 'create' || !event.conversation) return;
        await dispatch(assistant, {
          id: channel.conversationKey(event.conversation),
          input: {
            type: 'linear.comment.created',
            deliveryId: event.deliveryId,
            actor: event.actor,
            comment: event.payload,
          },
        });
        return;
      }
      case 'agent_session': {
        await dispatch(assistant, {
          id: channel.conversationKey(event.conversation),
          input: {
            type: `linear.agent_session.${event.action}`,
            promptContext: event.payload.promptContext,
            activity: event.payload.activity,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function postMessage(ref: LinearConversationRef) {
  return defineTool({
    name: 'post_linear_message',
    description: 'Post to the Linear conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      if (ref.type === 'agent-session') {
        const result = await client.createAgentActivity({
          agentSessionId: ref.agentSessionId,
          content: { type: 'response', body: text },
        });
        return JSON.stringify({ success: result.success });
      }

      const result = await client.createComment({
        issueId: ref.issueId,
        ...(ref.threadCommentId ? { parentId: ref.threadCommentId } : {}),
        body: text,
      });
      return JSON.stringify({ success: result.success });
    },
  });
}
```

Use `accessToken` instead of `apiKey` for an installed OAuth application.
OAuth installation storage and organization-specific token selection remain
application concerns.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/linear.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

Trusted code binds the organization, issue thread, or agent session. The model
selects only message text.

## Resource webhooks

Create a Linear webhook for the resource families the application handles,
typically Comments, Issues, and Projects. The package verifies the exact body
against `Linear-Signature`, rejects signed timestamps outside one minute, and
optionally checks configured organization and webhook ids.

Known comment, issue, and project payloads receive typed normalized variants.
Other verified deliveries use `type: 'unknown'`. Top-level comments and issue
events expose the issue conversation. Comment replies include the root comment
id for the nested thread.

## Agent sessions

Enable Agent session events on a Linear OAuth application configured as an app
actor. Install it with the scopes required by your operations and
`app:mentionable` when users should mention the agent.

`created` events carry the session and may include formatted prompt context,
previous thread comments, and guidance. `prompted` events carry the new user
activity. Both map to a stable agent-session conversation reference.

Linear expects the webhook response within five seconds and a new session to
receive an activity or external URL update within ten seconds. Keep the
verified handler focused on durable dispatch admission, then use the
project-owned SDK client to post progress and results.

## Delivery behavior

Returning nothing produces an empty `200`. Return JSON for a response body or
use the Hono context for explicit status control. A failure or non-`200`
response asks Linear to retry.

The channel exposes `Linear-Delivery` for application-owned deduplication but
does not persist delivery state. Conversation keys validate syntax, not
authorization.

See the [`@flue/linear` API reference](/docs/api/linear-channel/).
