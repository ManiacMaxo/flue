# Slack channel example

This example mounts separately verified Events API and interactivity routes,
explicitly dispatches app mentions and message-backed actions, derives a
canonical thread instance id, and pre-scopes Slack reply and root-reaction tools
to that destination.

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

Block actions return an empty acknowledgement. Visible follow-up messages use
the bot-token tools bound to the action's message thread; agent-driven
`response_url` use is intentionally deferred. Reactions target the bound thread
root.

The bot token's ownership by the configured app/workspace is a trusted
configuration assertion in v1. The package does not perform startup `auth.test`
network calls.

The channel module imports the agent and the agent imports the channel. This cycle is safe only because dispatch and tool access are deferred into handlers and the agent initializer. A routing module that imports both can avoid the cycle.

Conversation keys validate syntax, not authorization. This agent is intentionally dispatch-only. Any direct agent route must independently authorize the caller-selected instance id before deriving outbound tools from it.
