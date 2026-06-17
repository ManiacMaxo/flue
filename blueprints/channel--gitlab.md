---
{
  "kind": "channel",
  "version": 1,
  "website": "https://docs.gitlab.com/user/project/integrations/webhooks/"
}
---

# Add a GitLab Channel to Flue

You are an AI coding agent adding verified GitLab project or group webhook
ingress and application-owned GitLab API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
whether the application responds to issue notes, merge-request notes, merge
request events, push events, or another verified GitLab delivery.

Install `@flue/gitlab` with the project's package manager. Do not add a generic
GitLab tool collection.

## Create the channel

Create `<source-dir>/channels/gitlab.ts`. Adapt the imported agent and
dispatched input to the application, but preserve this ownership and routing
shape:

```ts
// flue-blueprint: channel/gitlab@1
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
    // `delivery.eventName` is the X-Gitlab-Event value. `delivery.payload`
    // keeps GitLab's native JSON field names and nesting. Filtering is
    // application policy: subscribe to the events you want in GitLab and branch here.
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

type GitLabNotePayload = GitLabWebhookPayload & {
  object_kind: 'note';
  project_id?: unknown;
  project?: unknown;
  user?: unknown;
  object_attributes: {
    id: number;
    note: string;
    noteable_type: string;
    action?: string;
    system?: boolean;
    url?: string;
  };
  issue?: unknown;
  merge_request?: unknown;
};

function isNoteEvent(payload: GitLabWebhookPayload): payload is GitLabNotePayload {
  if (payload.object_kind !== 'note' || !isRecord(payload.object_attributes)) return false;
  const note = payload.object_attributes;
  return typeof note.id === 'number' && typeof note.note === 'string' && typeof note.noteable_type === 'string';
}

function projectIdFrom(payload: GitLabNotePayload): number | undefined {
  const payloadProjectId = payload.project_id;
  if (typeof payloadProjectId === 'number' && Number.isSafeInteger(payloadProjectId) && payloadProjectId > 0) {
    return payloadProjectId;
  }
  if (isRecord(payload.project)) {
    const projectId = payload.project.id;
    if (typeof projectId === 'number' && Number.isSafeInteger(projectId) && projectId > 0) return projectId;
  }
  return undefined;
}

function isIssue(value: unknown): value is { iid: number; title?: string } {
  if (!isRecord(value)) return false;
  const iid = value.iid;
  return typeof iid === 'number' && Number.isSafeInteger(iid) && iid > 0;
}

function isMergeRequest(value: unknown): value is { iid: number; title?: string } {
  if (!isRecord(value)) return false;
  const iid = value.iid;
  return typeof iid === 'number' && Number.isSafeInteger(iid) && iid > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function postNote(ref: GitLabConversationRef) {
  return defineTool({
    name: 'post_gitlab_note',
    description: 'Post a note to the GitLab issue or merge request bound to this agent.',
    parameters: {
      type: 'object',
      properties: { body: { type: 'string', minLength: 1 } },
      required: ['body'],
      additionalProperties: false,
    },
    async execute({ body }) {
      const result =
        ref.type === 'issue'
          ? await client.createIssueNote({ projectId: ref.projectId, iid: ref.iid, body })
          : await client.createMergeRequestNote({ projectId: ref.projectId, iid: ref.iid, body });
      return JSON.stringify({ noteId: result.id, url: result.web_url });
    },
  });
}

class GitLabClient {
  constructor(private options: { instance: string; token: string; fetch?: typeof fetch }) {}

  createIssueNote(input: { projectId: number; iid: number; body: string }) {
    return this.createNote(`/api/v4/projects/${input.projectId}/issues/${input.iid}/notes`, input.body);
  }

  createMergeRequestNote(input: { projectId: number; iid: number; body: string }) {
    return this.createNote(`/api/v4/projects/${input.projectId}/merge_requests/${input.iid}/notes`, input.body);
  }

  private async createNote(path: string, body: string): Promise<{ id: number; web_url?: string }> {
    const response = await (this.options.fetch ?? fetch)(`${this.options.instance.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'private-token': this.options.token },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) throw new Error(`GitLab note request failed with ${response.status}.`);
    const json = await response.json();
    if (!isRecord(json) || typeof json.id !== 'number') throw new Error('Invalid GitLab note response.');
    return { id: json.id, ...(typeof json.web_url === 'string' ? { web_url: json.web_url } : {}) };
  }
}
```

For Cloudflare projects, follow the project's existing credential convention.
Flue enables `nodejs_compat`, so `process.env` is supported; typed bindings
from `cloudflare:workers` are also valid when the project prefers them. The
completed project must pass its actual Cloudflare build.

If the user did not ask for notes on issues or merge requests, replace or omit
the example tool. Never let the model choose arbitrary instances, projects,
IIDs, API paths, tokens, or credentials unless the application has explicitly
authorized that.

## Wire the agent

Bind the trusted conversation destination inside the agent initializer:

```ts
import { createAgent } from '@flue/runtime';
import { channel, postNote } from '../channels/gitlab.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postNote(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported only because these imported
bindings are read inside deferred callbacks and initializers. Do not read the
agent binding while constructing `channel`.

## Credentials and verification

`GITLAB_WEBHOOK_SIGNING_TOKEN` verifies GitLab 19.0+ signed webhook bytes. It
must have the `whsec_` prefix and encode a 32-byte HMAC key. Prefer this for
new webhooks; GitLab 19.1 made signing tokens generally available.

`GITLAB_WEBHOOK_SECRET_TOKEN` verifies legacy `X-Gitlab-Token` deliveries from
older GitLab versions and migration windows. It is weaker because it is sent as
a plain-text header, but `@flue/gitlab` supports it for compatibility. If both
tokens are configured and a request carries `webhook-signature`, an invalid
signature receives `401` and does not fall back to the legacy token.

`GITLAB_TOKEN` authenticates outbound REST calls. `GITLAB_INSTANCE` selects the
GitLab instance for outbound calls and defaults to `https://gitlab.com`. Ingress
verification credentials and outbound API credentials serve different purposes.
Follow existing project secret conventions and never invent values.

Configure the GitLab webhook content type as JSON. Subscribe to the minimum
event set the application handles; the example uses **Comments** / `Note Hook`.
Run the project's typecheck and configured Flue build. Create local JSON
payloads and HMAC signatures to test success, invalid signatures, legacy token
fallback, issue-note and merge-request-note variants, `/channels/gitlab/webhook`,
and the empty `200` default. Exercise one GitLab REST call through a fake Fetch
transport in workerd. Do not contact GitLab.

GitLab can retry failed deliveries and can temporarily or permanently disable
slow or failing webhooks. Admit durable work quickly and deduplicate on
`delivery.deliveryId` (`webhook-id`) or `delivery.idempotencyKey` when it matters.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-17

Initial version.
