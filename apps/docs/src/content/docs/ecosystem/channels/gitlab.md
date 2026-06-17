---
title: GitLab
description: Receive signed GitLab project and group webhooks and post notes from application-owned tools.
package:
  name: '@flue/gitlab'
  href: https://www.npmjs.com/package/@flue/gitlab
---

## Quickstart

Add verified GitLab webhook ingress and application-owned API behavior to an existing Flue project with the [GitLab](https://docs.gitlab.com/user/project/integrations/webhooks/) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel gitlab
```

## Overview

The blueprint installs `@flue/gitlab`, creates `<source-root>/channels/gitlab.ts`
with a named `channel`, a small project-owned Fetch `client`, and a GitLab note
tool, then wires that tool into an agent. Adapt the subscribed events,
dispatched input, and tool to the application.

```ts title="src/channels/gitlab.ts (abridged)"
import { createGitLabChannel } from '@flue/gitlab';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

export const channel = createGitLabChannel({
  signingToken: process.env.GITLAB_WEBHOOK_SIGNING_TOKEN,
  secretToken: process.env.GITLAB_WEBHOOK_SECRET_TOKEN,

  async webhook({ delivery }) {
    if (delivery.eventName !== 'Note Hook') return;
    if (delivery.payload.object_kind !== 'note') return;
    const note = delivery.payload.object_attributes;
    if (note?.noteable_type !== 'Issue' || note.action !== 'create') return;

    await dispatch(assistant, {
      id: channel.conversationKey({
        type: 'issue',
        instance: delivery.instance ?? 'https://gitlab.com',
        projectId: Number(delivery.payload.project_id),
        iid: Number((delivery.payload.issue as { iid: number }).iid),
      }),
      input: {
        type: 'gitlab.issue_note.created',
        deliveryId: delivery.deliveryId,
        idempotencyKey: delivery.idempotencyKey,
        note,
      },
    });
  },
});
```

A new GitLab note is admitted to the agent bound to that issue or merge request;
other verified deliveries receive an empty successful response. The full
generated module includes type guards, handles both issue notes and merge
request notes, and lets the bound agent post a note through GitLab's REST API.

## Configure

| Variable                       | Purpose                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GITLAB_WEBHOOK_SIGNING_TOKEN` | **Recommended** — Verifies GitLab 19.0+ signed webhook bytes.                                               |
| `GITLAB_WEBHOOK_SECRET_TOKEN`  | **Optional** — Verifies legacy `X-Gitlab-Token` deliveries from older GitLab versions or migration windows. |
| `GITLAB_TOKEN`                 | **Required for the example** — Authenticates outbound REST calls.                                           |
| `GITLAB_INSTANCE`              | **Optional** — GitLab instance for outbound calls. Defaults to `https://gitlab.com`.                        |

Configure the GitLab webhook URL as:

```txt
https://example.com/channels/gitlab/webhook
```

If `flue()` is mounted beneath an outer prefix, include that prefix. Subscribe
to the minimum event set the application handles. The example uses GitLab
comments (`Note Hook`) for issues and merge requests.

Prefer GitLab's signing token for new webhooks. GitLab introduced signing tokens
in 19.0 and made them generally available in 19.1. The token has the
`whsec_...` form and verifies an HMAC over the exact JSON body, `webhook-id`,
and `webhook-timestamp`. Legacy secret tokens are sent in `X-Gitlab-Token` as a
plain-text header and are weaker, but the channel supports them for GitLab
versions before signing tokens and for no-downtime migrations. If both tokens
are configured and a request includes `webhook-signature`, an invalid signature
receives `401` and does not fall back to the legacy token.

## Channel module

```ts title="src/channels/gitlab.ts"
import {
  createGitLabChannel,
  type GitLabConversationRef,
  type GitLabWebhookPayload,
} from '@flue/gitlab';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

const gitlabInstance = process.env.GITLAB_INSTANCE ?? 'https://gitlab.com';

export const client = new GitLabClient({
  instance: gitlabInstance,
  token: process.env.GITLAB_TOKEN!,
});

export const channel = createGitLabChannel({
  signingToken: process.env.GITLAB_WEBHOOK_SIGNING_TOKEN,
  secretToken: process.env.GITLAB_WEBHOOK_SECRET_TOKEN,

  // Path: /channels/gitlab/webhook
  async webhook({ delivery }) {
    if (delivery.eventName !== 'Note Hook' || !isNoteEvent(delivery.payload)) return;
    const note = delivery.payload.object_attributes;
    if (note.action !== 'create' || note.system) return;

    const projectId = projectIdFrom(delivery.payload);
    const instance = delivery.instance ?? gitlabInstance;
    if (projectId === undefined) return;

    if (note.noteable_type === 'Issue' && isIssue(delivery.payload.issue)) {
      const ref = {
        type: 'issue' as const,
        instance,
        projectId,
        iid: delivery.payload.issue.iid,
      };
      await dispatch(assistant, {
        id: channel.conversationKey(ref),
        input: {
          type: 'gitlab.issue_note.created',
          deliveryId: delivery.deliveryId,
          idempotencyKey: delivery.idempotencyKey,
          issue: ref,
          sender: delivery.payload.user,
          note: { id: note.id, body: note.note, url: note.url },
        },
      });
      return;
    }

    if (note.noteable_type === 'MergeRequest' && isMergeRequest(delivery.payload.merge_request)) {
      const ref = {
        type: 'merge-request' as const,
        instance,
        projectId,
        iid: delivery.payload.merge_request.iid,
      };
      await dispatch(assistant, {
        id: channel.conversationKey(ref),
        input: {
          type: 'gitlab.merge_request_note.created',
          deliveryId: delivery.deliveryId,
          idempotencyKey: delivery.idempotencyKey,
          mergeRequest: ref,
          sender: delivery.payload.user,
          note: { id: note.id, body: note.note, url: note.url },
        },
      });
    }
  },
});
```

Every verified delivery is forwarded with its native GitLab payload. There is no
fixed list of supported events and no normalization layer: the payload keeps
GitLab's own field names and nesting, such as `object_kind`, `event_name`,
`object_attributes.noteable_type`, `issue.iid`, and `merge_request.iid`.
Choosing which events to act on is application policy — subscribe to them in
GitLab and branch on `delivery.eventName` and native payload fields in the
handler.

GitLab does not publish an authoritative TypeScript package for webhook bodies,
so `@flue/gitlab` exports a broad `GitLabWebhookPayload` object. Use small
application-side type guards for the event families your app handles.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import { channel, postNote } from '../channels/gitlab.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postNote(channel.parseConversationKey(id))],
}));
```

Trusted code binds the GitLab instance, project id, issue iid, or merge request
iid. The model selects only the note body. The channel-agent import cycle is
supported because both imported bindings are read only inside deferred callbacks
or initializers.

## GitLab REST client

The channel package owns inbound verification only. Outbound GitLab calls belong
to project code. The blueprint uses a minimal Fetch client for the note routes:

```ts
class GitLabClient {
  constructor(private options: { instance: string; token: string }) {}

  async createIssueNote(input: { projectId: number; iid: number; body: string }) {
    return this.createNote(
      `/api/v4/projects/${input.projectId}/issues/${input.iid}/notes`,
      input.body,
    );
  }

  async createMergeRequestNote(input: { projectId: number; iid: number; body: string }) {
    return this.createNote(
      `/api/v4/projects/${input.projectId}/merge_requests/${input.iid}/notes`,
      input.body,
    );
  }

  private async createNote(path: string, body: string) {
    const response = await fetch(`${this.options.instance}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'private-token': this.options.token },
      body: JSON.stringify({ body }),
    });
    return response.json();
  }
}
```

Use OAuth or project/group access tokens according to your GitLab installation
and authorization model. Token storage, rotation, and per-project authorization
remain application concerns.

## Delivery behavior

Returning nothing produces an empty `200`. Return JSON for a response body or
use the Hono context for explicit status control. GitLab treats `2xx` responses
as successful deliveries. Slow, unstable, or non-`2xx` responses can be retried
and can temporarily or permanently disable the webhook after repeated failures.

The channel does not deduplicate. Prefer `delivery.deliveryId` (`webhook-id`) or
`delivery.idempotencyKey` when duplicate admission is unacceptable. Newer GitLab
versions document those values as consistent across retries. `delivery.eventUuid`
comes from `X-Gitlab-Event-UUID`; recursive webhooks can share that value, so do
not use it as the only deduplication key for external effects.

## Runtime support

`@flue/gitlab` uses Web Crypto, Fetch, and Hono-compatible handlers and is tested
on Node and workerd. The example's note client is also exercised in workerd with
Flue's required `nodejs_compat` configuration and a fake Fetch transport.

See the [`@flue/gitlab` API reference](/docs/api/gitlab-channel/).
