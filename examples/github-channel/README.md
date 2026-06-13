# GitHub channel example

This example receives verified GitHub webhook ingress at
`/channels/github/webhook`, explicitly dispatches supported events to an agent,
derives a canonical issue or pull-request instance id, and defines one
application-owned Octokit tool bound to that destination.

`GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN` are required when the built application starts. Builds and type checks do not require live credentials.

Configure the GitHub webhook content type as either `application/json` or
`application/x-www-form-urlencoded`. The route must receive the unconsumed
request body because signatures cover the exact bytes sent by GitHub.

The handler completes dispatch admission before returning `200`. GitHub expects
a response within 10 seconds and does not automatically retry failures; failed
deliveries can be inspected and manually redelivered with the same delivery id.

The channel module exports both the ingress `channel` and the project-owned
Octokit `client`. The comment tool is deliberately narrow application policy,
not a generic tool supplied by `@flue/github`.

The channel module imports the agent and the agent imports the channel. This
cycle is safe because the imported bindings are read only inside the webhook
callback and agent initializer, after module evaluation.

Conversation keys validate syntax, not authorization. This agent is intentionally dispatch-only. Any direct agent route must independently authorize the caller-selected instance id before deriving outbound tools from it.
