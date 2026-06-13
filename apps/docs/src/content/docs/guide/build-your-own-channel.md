---
title: Build a custom channel
description: Add verified provider ingress and application-owned SDK tools.
---

Use the generic channel recipe when Flue does not provide a first-party ingress
package:

```sh
flue add https://provider.example/webhooks --category channel --print | codex
```

A custom channel is ordinary application code discovered from
`channels/<name>.ts`. It owns provider verification and normalization. Outbound
API calls use the provider's established SDK or a narrow project-owned Fetch
client. Tools remain application policy.

## Define discovered routes

Export a named `channel` value with one or more route declarations:

```ts title="src/channels/acme.ts"
import type { Handler } from 'hono';

const MAX_BODY_BYTES = 1024 * 1024;

const webhook: Handler = async (c) => {
  const rawBody = await readLimitedBody(c.req.raw, MAX_BODY_BYTES);
  if (!rawBody) return c.body(null, 413);

  const signature = c.req.header('x-acme-signature');
  if (!signature || !(await verifyAcmeSignature(rawBody, signature))) {
    return c.body(null, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    return c.body(null, 400);
  }

  await handleVerifiedEvent(c, normalizeAcmeEvent(payload));
  return c.body(null, 200);
};

export const channel = {
  routes: [{ method: 'POST', path: '/webhook', handler: webhook }],
};
```

With `channels/acme.ts`, Flue serves this declaration at
`/channels/acme/webhook`. Route suffixes must be non-empty, begin with `/`,
contain no query or fragment, and remain beneath the filename-derived channel
namespace. The namespace itself is not an endpoint.

Use `/webhook` for one ordinary webhook, `/events` for a protocol explicitly
named an Events API, and provider-native names such as `/interactions` when the
surface has different response semantics.

Do not create `app.ts` merely to mount the channel. If an existing `app.ts`
mounts `flue()` at `/api`, this route becomes `/api/channels/acme/webhook`.

## Verify exact bytes

Provider signatures usually cover the original body. Enforce a conservative
size limit, verify the signature before parsing, and define exact behavior for
methods, content types, malformed bodies, stale timestamps, and provider
identity.

Use Web Crypto where practical, or pass a project-owned SDK client into a
provider-specific constructor when that SDK adds ingress verification value.
There is no universal channel client interface.

## Normalize and dispatch

Give one application callback ownership of each protocol surface. A
discriminated event union lets the application group related provider cases:

```ts
async function handleVerifiedEvent(c: Context, event: AcmeEvent) {
  switch (event.type) {
    case 'message.created':
    case 'message.updated':
      await dispatch(assistant, {
        id: conversationKey(event.thread),
        input: {
          type: `acme.${event.type}`,
          deliveryId: event.deliveryId,
          text: event.text,
        },
      });
      return;
    default:
      return;
  }
}
```

Preserve stable delivery identity when useful for idempotency. Keep raw
payloads, credentials, webhook response URLs, and short-lived provider
capabilities out of model-visible or durable input.

Use ordinary Hono responses. A notification surface may default to an empty
`200`; an interaction protocol may require provider-native JSON. Document that
per surface instead of inventing a Flue-wide response object.

## Use the provider SDK

Export the initialized SDK client from the channel module:

```ts
export const client = new AcmeClient({
  token: process.env.ACME_TOKEN,
});
```

Prefer a provider-maintained REST SDK. If none exists, use the dominant
maintained client and state that distinction. Avoid gateway or long-lived
connection clients when the application needs only outbound HTTP calls.

Validate the selected SDK against the project's actual Node or Cloudflare
target. A first-party ingress package being portable does not imply that every
outbound SDK is.

## Define narrow tools

Bind credentials and destinations in trusted application code:

```ts
export function replyInThread(ref: AcmeThreadRef) {
  return defineTool({
    name: 'reply_in_acme_thread',
    description: 'Reply in the Acme thread bound to this agent.',
    parameters: v.object({
      text: v.string(),
    }),
    async execute({ text }) {
      await client.messages.create({
        threadId: ref.threadId,
        text,
      });
      return 'Reply posted.';
    },
  });
}
```

The model selects message content, not the credential or destination.
Conversation keys identify provider destinations; they do not authorize
caller-selected agent ids.

## Test the boundary

Use representative local payloads rather than live provider services:

- valid and invalid signatures over exact non-canonical bytes;
- body limits, malformed payloads, methods, and content types;
- provider handshakes and identity mismatch;
- known and unknown normalized event variants;
- default acknowledgements and required provider responses;
- filename-derived route paths and `flue()` prefixes;
- conversation-key round trips;
- deferred channel-agent import cycles;
- Node and claimed Cloudflare builds with the actual SDK import.

The first-party package tests under `packages/github`, `packages/slack`, and
`packages/discord` are concrete ingress examples.
