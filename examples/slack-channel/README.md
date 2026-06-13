# Slack channel example

This example receives verified Slack Events API requests at
`/channels/slack/events`, explicitly dispatches app mentions, derives a
canonical thread instance id, and defines one application-owned Slack SDK tool
bound to that thread. The optional `/channels/slack/interactions` surface is
shown commented out in the channel module and is not published.

`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_ID`, and `SLACK_TEAM_ID` are required when the built application starts. Builds and type checks do not require live credentials.

The routes must receive the unconsumed request body because signatures cover
the exact bytes sent by Slack. Requests older than five minutes are rejected.
The configured app and workspace ids are checked before handlers run. This
fixed-workspace example does not support org installations.

Handlers complete dispatch admission before Slack is acknowledged. The default
handler deadline is 2.5 seconds. A timed-out handler cannot be forcibly stopped
and may still admit work after a failure response; Slack may retry Events API
deliveries, so applications requiring uniqueness must claim `eventId` in
durable application storage before dispatch.

The bot token's ownership by the configured app/workspace is a trusted
configuration assertion in v1. The package does not perform startup `auth.test`
network calls.

The channel module exports both the ingress `channel` and the project-owned
`WebClient`. The reply tool is deliberately narrow application policy, not a
generic tool supplied by `@flue/slack`.

This example uses the Fetch-based `@slack/web-api` v8 release candidate. Its
typed `chat.postMessage()` path is exercised in workerd with Cloudflare's
required `nodejs_compat` flag and without contacting Slack.

The channel module imports the agent and the agent imports the channel. This
cycle is safe because the imported bindings are read only inside the events
callback and agent initializer, after module evaluation.

Conversation keys validate syntax, not authorization. This agent is intentionally dispatch-only. Any direct agent route must independently authorize the caller-selected instance id before deriving outbound tools from it.
