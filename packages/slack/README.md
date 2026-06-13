# `@flue/slack`

First-party Slack events, interactions, and outbound-tool integration for Flue.

```ts
const slack = createSlackChannel({
	signingSecret: process.env.SLACK_SIGNING_SECRET!,
	botToken: process.env.SLACK_BOT_TOKEN!,
	appId: process.env.SLACK_APP_ID!,
	teamId: process.env.SLACK_TEAM_ID!,
});

slack.on('app_mention', async (event) => {
	// Choose the agent, instance id, and dispatched input in application code.
});

app.mount('/webhooks/slack/events', slack.routes.events());
app.mount('/webhooks/slack/interactions', slack.routes.interactions());
```

Both routes verify the exact request bytes and reject timestamps outside Slack's
five-minute freshness window. Mount them before body-parsing middleware.
`api_app_id` and workspace identity are checked before application handlers.
This fixed-workspace v1 rejects org-installed interaction payloads.

Events API handlers support `app_mention` and plain user `message` events.
Message subtypes and bot messages are acknowledged and ignored. Retry metadata
is exposed but deliveries are not deduplicated.

Interactivity supports message-backed `block_actions` with acknowledgement-only
responses and modal `view_submission` handlers with acknowledgement or field
validation errors. `response_url` capabilities are not exposed to agent tools.

The default handler deadline is 2.5 seconds. A successful response means the
handler completed, but a timed-out handler cannot be forcibly cancelled and may
still complete after Slack receives a failure response. Application-owned
delivery claims are required when duplicate admission is unacceptable.

`slack.client` provides thread replies and root reactions through the configured
bot token. `slack.tools` pre-binds the trusted workspace/thread destination.
The token's ownership by the configured app/workspace is a trusted application
configuration assertion; no startup identity request is made.
