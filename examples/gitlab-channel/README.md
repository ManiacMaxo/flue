# GitLab channel example

This example receives verified GitLab project or group webhooks at
`/channels/gitlab/webhook`, dispatches issue and merge-request notes to an
agent, derives a canonical GitLab conversation id, and defines one
application-owned Fetch tool bound to that destination.

`GITLAB_TOKEN` and either `GITLAB_WEBHOOK_SIGNING_TOKEN` or
`GITLAB_WEBHOOK_SECRET_TOKEN` are required when the built application starts.
`GITLAB_INSTANCE` defaults to `https://gitlab.com`.

Prefer GitLab 19.1+ signing tokens for new webhooks. Legacy
`X-Gitlab-Token` verification is supported for GitLab versions before signing
tokens and for migration windows. If both tokens are configured, signed
requests fail closed on an invalid signature rather than falling back to the
legacy token.

Configure GitLab to send JSON webhooks to the route above. The handler
completes dispatch admission before returning `200`. GitLab can retry or
auto-disable slow and failing webhooks, so admit durable work quickly and
deduplicate on `webhook-id` or `Idempotency-Key` when it matters.

The channel module exports both the ingress `channel` and the project-owned
GitLab `client`. The note tool is deliberately narrow application policy, not a
generic tool supplied by `@flue/gitlab`.

The GitLab REST note paths are exercised in workerd through a fake Fetch
transport with Flue's required `nodejs_compat` configuration and without
contacting GitLab.

The channel module imports the agent and the agent imports the channel. This
cycle is safe because the imported bindings are read only inside the webhook
callback and agent initializer, after module evaluation.

Conversation keys validate syntax, not authorization. This agent is intentionally dispatch-only. Any direct agent route must independently authorize the caller-selected instance id before deriving outbound tools from it.
