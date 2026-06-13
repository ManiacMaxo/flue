---
title: GitHub Channel API
description: Reference for verified GitHub webhook ingress from @flue/github.
lastReviewedAt: 2026-06-13
---

Import from `@flue/github`.

## `createGitHubChannel()`

```ts
function createGitHubChannel<E extends Env = Env>(
  options: GitHubChannelOptions<E>,
): GitHubChannel<E>;
```

Creates one stateless GitHub webhook channel. The callback is stored during
construction and runs only for a verified non-ping delivery.

## `GitHubChannelOptions`

```ts
interface GitHubChannelOptions<E extends Env = Env> {
  webhookSecret: string;
  bodyLimit?: number;
  webhook(input: {
    c: Context<E>;
    event: GitHubEvent;
  }): void | JsonValue | Response | Promise<void | JsonValue | Response>;
}
```

| Field           | Description                                     |
| --------------- | ----------------------------------------------- |
| `webhookSecret` | Secret configured on the GitHub webhook.        |
| `bodyLimit`     | Maximum request body in bytes. Default: 25 MiB. |
| `webhook`       | Receives every verified non-ping delivery.      |

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. An ordinary Hono or Fetch `Response` passes through unchanged.
Thrown callbacks produce a server error.

## `GitHubChannel`

```ts
interface GitHubChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: GitHubIssueRef): string;
  parseConversationKey(id: string): GitHubIssueRef;
}
```

`routes` contains one `POST /webhook` declaration used by discovered channel
routing. A file named `channels/github.ts` is served at
`/channels/github/webhook` relative to the `flue()` mount.

Conversation keys are canonical identifiers, not authorization capabilities.
Pull requests use their issue number.

## Events

```ts
type GitHubEvent = GitHubEvents[keyof GitHubEvents] | GitHubUnknownEvent;
```

Known variants:

- `issues.opened`
- `issue_comment.created`
- `pull_request.opened`

```ts
interface GitHubWebhookEvent<TType extends string, TPayload> {
  type: TType;
  deliveryId: string;
  hookId?: string;
  installationTarget?: { id: string; type: string };
  installationId?: number;
  repository: GitHubRepositoryRef;
  payload: TPayload;
  raw: unknown;
}
```

Unsupported verified event/action combinations use:

```ts
interface GitHubUnknownEvent {
  type: 'unknown';
  event: string;
  action?: string;
  deliveryId: string;
  hookId?: string;
  installationTarget?: { id: string; type: string };
  installationId?: number;
  raw: unknown;
}
```

GitHub `ping` is acknowledged internally and does not invoke `webhook`.
Signatures are checked against exact request bytes before form or JSON parsing.
The package does not deduplicate `deliveryId`.

## Identity

```ts
interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

interface GitHubRepositoryRef {
  id: number;
  owner: string;
  name: string;
}
```

## Errors

- `InvalidGitHubConversationKeyError`
- `InvalidGitHubInputError`, with structured `field`

See [GitHub setup](/docs/guide/channels/github/) for composition with Octokit
and application-owned tools.
