---
title: smolvm
description: Run Flue sandbox work in a local libkrun-backed virtual machine.
lastReviewedAt: 2026-05-30
---

The smolvm adapter adapts an initialized `Machine` from `smolvm-embedded` into Flue's sandbox interface. Unlike a hosted sandbox service, smolvm runs locally through a host hypervisor.

## Quickstart

Add local microVM sandbox capability to an existing Flue project with the [smolvm](https://smolmachines.com) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox smolvm
```

## Overview

The blueprint installs `smolvm-embedded` when needed and creates `sandboxes/smolvm.ts` in your source-root. The generated adapter accepts an initialized local `Machine`; machine creation, connection, networking, shutdown, and deletion remain application-owned.

```ts title="<source-root>/sandboxes/smolvm.ts (abridged)"
// flue-blueprint: sandbox/smolvm@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Machine } from 'smolvm-embedded';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class SmolvmSandboxApi implements SandboxApi {
  constructor(private machine: Machine) {}

  /* ... generated file operations using Machine methods and quoted POSIX commands ... */

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.machine.exec(['sh', '-lc', command], {
      workdir: options?.cwd,
      env: options?.env,
      timeout:
        typeof options?.timeoutMs === 'number' ? Math.ceil(options.timeoutMs / 1000) : undefined,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
}

export function smolvm(machine: Machine): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = '/workspace';
      const api = new SmolvmSandboxApi(machine);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass an initialized smolvm `Machine` to `smolvm(...)` and assign the returned factory to an agent's `sandbox` property. Flue resolves relative paths from `/workspace`; commands run through `sh -lc`, and Flue's millisecond `timeoutMs` is rounded up to the whole seconds accepted by smolvm.

## Configure

| Requirement               | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `smolvm-embedded` package | **Required** — Provides the initialized machine adapted by Flue.              |
| macOS or Linux host       | **Required** — Supplies suitable local virtualization and hypervisor support. |
| Credentials               | **Not required** — smolvm itself requires none.                               |
| Edge or Worker runtime    | **Unsupported** — These runtimes cannot execute a local hypervisor.           |

## Choose this adapter when

Use smolvm for trusted desktop, CI, or server environments where local microVM execution is the desired isolation boundary. The host running the Flue application must support the underlying virtualization mechanism; this is not a Cloudflare Worker sandbox option.

The adapter blueprint treats networking and machine lifetime as explicit choices. Do not assume a local VM has network access or that it will be cleaned up without your application doing so.

See [Deploy on Node.js](/docs/ecosystem/deploy/node/), [Sandboxes](/docs/guide/sandboxes/), and [Sandbox Adapter API](/docs/api/sandbox-api/).
