// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
export const COPY_PROMPT = `fetch https://flueframework.com/start.md to create a new agent`;

export const HERO = `import { createAgent, http, type FlueContext } from '@flue/runtime';
import triage from '../skills/triage/SKILL.md' with { type: 'skill' };
import { lookupIssue, listRepoLabels } from '../tools/github';
import * as v from 'valibot';

export const channels = [http()];

// Agents maintain context and safely take action inside an isolated sandbox:
const agent = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Investigate issues, make safe fixes, and clearly report your work.',
  skills: [triage],
  tools: [lookupIssue, listRepoLabels],
}));

// Workflows coordinate deterministic execution around agent-driven work:
export async function run({ init, payload, env }: FlueContext) {
  const harness = await init(agent);
  const session = await harness.session();

  // Let the agent use its skills and tools, then return structured output:
  const { data } = await session.prompt(\`Triage this issue: #\${payload.issueNumber}\`, {
    result: v.object({ comment: v.string(), labels: v.array(v.string()) }),
  });

  // Protect sensitive tokens and API keys with fine-grained control:
  await session.shell(\`gh issue comment \${Number(payload.issueNumber)} --body \${JSON.stringify(data.comment)}\`, {
    env: { GITHUB_TOKEN: env.GITHUB_TOKEN },
  });
}`;

