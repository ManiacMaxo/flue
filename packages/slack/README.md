# `@flue/slack`

Verified Slack Events API and interactivity ingress for Flue applications.

```ts
import { createSlackChannel } from '@flue/slack';

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  appId: process.env.SLACK_APP_ID!,
  teamId: process.env.SLACK_TEAM_ID!,

  // Path: /channels/slack/events
  async events({ event }) {
    await handleEvent(event);
  },

  // Omit this callback to omit the route.
  // Path: /channels/slack/interactions
  async interactions({ interaction }) {
    await handleInteraction(interaction);
  },
});
```

Place this export in `channels/slack.ts`. Flue discovers configured surfaces at
`/channels/slack/events` and `/channels/slack/interactions` relative to the
`flue()` mount. At least one callback is required.

The package verifies exact request bytes and Slack's timestamp window, handles
URL verification internally, checks configured app and workspace identity, and
normalizes known and unknown verified payloads. Returning nothing produces an
empty `200`; JSON values, Slack view-validation bodies, and ordinary Hono
responses are supported.

This package does not include an outbound Slack client or model tools. Run
`flue add slack` to generate editable project code using the Slack Web API or a
target-compatible Fetch client and application-owned `defineTool(...)` values.

Conversation keys are stable thread identifiers, not authorization
capabilities. The package is stateless and does not deduplicate Events API
retries.
