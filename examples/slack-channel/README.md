# Slack channel example

This example receives verified Slack Events API requests at
`/channels/slack/events`, explicitly dispatches app mentions, derives a
canonical thread instance id, and defines one application-owned Slack SDK tool
bound to that thread. The optional `/channels/slack/interactions` and
`/channels/slack/commands` surfaces are shown commented out in the channel
module and are not published.

`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_ID`, and `SLACK_TEAM_ID` are required when the built application starts. Builds and type checks do not require live credentials.

The routes must receive the unconsumed request body because signatures cover
the exact bytes sent by Slack. Requests older than five minutes are rejected.
The configured app and workspace ids are checked before handlers run. This
fixed-workspace example rejects org-wide installations. Slack's signed URL
verification request does not include app or workspace ids and is acknowledged
internally.

Handlers complete dispatch admission before Slack is acknowledged. The default
handler deadline is 2.5 seconds. A timed-out handler cannot be forcibly stopped
and may still admit work after a failure response; Slack may retry Events API
deliveries, so applications requiring uniqueness must claim `payload.event_id` in
durable application storage before dispatch.

The bot token's ownership by the configured app/workspace is a trusted
configuration assertion in v1. The package does not perform startup `auth.test`
network calls.

The channel module exports both the ingress `channel` and the project-owned
`WebClient`. The reply tool is deliberately narrow application policy, not a
generic tool supplied by `@flue/slack`.

Interactions and slash commands preserve Slack's native snake_case fields.
Values such as `trigger_id`, `response_url`, and view `response_urls` are
short-lived provider capabilities. Use them only inside trusted request
handling. Never place them in dispatch input, model context, logs, or durable
session data.

This example uses the Fetch-based `@slack/web-api` v8 release candidate. Its
typed `chat.postMessage()` path is exercised in workerd with Cloudflare's
required `nodejs_compat` flag and without contacting Slack.

The channel module imports the agent and the agent imports the channel. This
cycle is safe because the imported bindings are read only inside the events
callback and agent initializer, after module evaluation.

Conversation keys validate syntax, not authorization. This agent is intentionally dispatch-only. Any direct agent route must independently authorize the caller-selected instance id before deriving outbound tools from it.
