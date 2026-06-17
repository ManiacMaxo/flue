# `@flue/gitlab`

Verified GitLab project and group webhook ingress for Flue applications.

```ts
import { createGitLabChannel } from '@flue/gitlab';

export const channel = createGitLabChannel({
  signingToken: process.env.GITLAB_WEBHOOK_SIGNING_TOKEN,
  secretToken: process.env.GITLAB_WEBHOOK_SECRET_TOKEN,

  // Path: /channels/gitlab/webhook
  async webhook({ delivery }) {
    if (
      delivery.eventName === 'Note Hook' &&
      delivery.payload.object_kind === 'note' &&
      delivery.payload.object_attributes?.noteable_type === 'Issue'
    ) {
      await handleIssueNote(delivery.payload);
    }
  },
});
```

Place this export in `channels/gitlab.ts`. Flue discovers it and serves
`POST /channels/gitlab/webhook` relative to the `flue()` mount.

The package verifies exact request bytes before parsing. GitLab 19.0+ signed
webhooks use Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, and
`webhook-signature`) with a `whsec_...` signing token. Legacy webhooks use
`X-Gitlab-Token` when `secretToken` is configured. If a signed request is
present and `signingToken` is configured, a failed signature does not fall back
to the legacy token.

Every verified delivery is forwarded with its native GitLab JSON payload and
`X-Gitlab-Event` name. Choosing which events to act on is application policy:
subscribe to them in GitLab and branch in the handler. Returning nothing
produces an empty `200`; JSON values and ordinary Hono responses are also
supported.

This package does not include an outbound GitLab client or model tools. Run
`flue add channel gitlab` to generate editable project code using a narrow
application-owned Fetch client and `defineTool(...)` values.

Conversation keys are stable issue or merge-request identifiers, not
authorization capabilities. The package is stateless and does not deduplicate
delivery ids. GitLab can retry or disable slow/failing webhooks, so admit
durable work quickly and deduplicate on `delivery.deliveryId` or
`delivery.idempotencyKey` when it matters.
