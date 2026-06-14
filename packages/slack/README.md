# `@flue/slack`

Verified Slack Events API, interactivity, and slash-command ingress for Flue
applications.

```ts
import { createSlackChannel } from '@flue/slack';

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  appId: process.env.SLACK_APP_ID!,
  teamId: process.env.SLACK_TEAM_ID!,

  // Path: /channels/slack/events
  async events({ c, payload }) {
    if (payload.type !== 'event_callback') return;

    switch (payload.event.type) {
      case 'app_mention':
        await handleMention(payload.event, payload.event_id);
        return;
      default:
        console.log(c.req.header('x-slack-retry-num'));
        return;
    }
  },

  // Omit this callback to omit the route.
  // Path: /channels/slack/interactions
  async interactions({ payload }) {
    await handleInteraction(payload);
  },

  // Omit this callback to omit the route.
  // Path: /channels/slack/commands
  async commands({ c, payload }) {
    return c.json({ response_type: 'ephemeral', text: `Received ${payload.command}` });
  },
});
```

Place the named `channel` export in `channels/slack.ts`. Flue serves configured
surfaces at:

- `POST /channels/slack/events`
- `POST /channels/slack/interactions`
- `POST /channels/slack/commands`

Paths are relative to the `flue()` mount. Omitting a callback omits its route;
at least one callback is required.

The package verifies Slack signatures over exact request bytes, enforces the
five-minute timestamp window, checks the configured app and workspace, and
rejects org-wide installations. URL verification is handled internally.
Authenticated application deliveries preserve Slack's field names, nesting,
and discriminants. Nested Events API events use the official `SlackEvent` type
from `@slack/types`, which this package re-exports.

Returning nothing produces an empty `200`. JSON-compatible values become JSON
responses, and ordinary Hono or Fetch `Response` values pass through.
Callbacks have a default and maximum 2.5-second deadline.

This package does not include an outbound Slack client or model tools. Run
`flue add slack` for editable project code using the official
`@slack/web-api` client. Conversation keys are stable thread identifiers, not
authorization capabilities. The package is stateless and does not deduplicate
Events API retries.
