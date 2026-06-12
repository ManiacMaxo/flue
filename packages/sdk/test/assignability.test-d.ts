import {
	IMAGE_DATA_OMITTED as RUNTIME_IMAGE_DATA_OMITTED,
	type FlueEvent as RuntimeFlueEvent,
	type PromptResponse as RuntimePromptResponse,
	type PromptUsage as RuntimePromptUsage,
	type RunRecord as RuntimeRunRecord,
} from '@flue/runtime';
import {
	IMAGE_DATA_OMITTED as SDK_IMAGE_DATA_OMITTED,
	type AgentPromptResponse,
	type FlueEvent as SdkFlueEvent,
	type PromptUsage as SdkPromptUsage,
	type RunRecord as SdkRunRecord,
} from '../src/index.ts';

// `turn_request` is in-process only (`observe()` subscribers and exporters);
// it is never persisted to durable streams or served over HTTP, so the SDK
// wire union deliberately omits it.
const _: SdkFlueEvent = {} as Exclude<RuntimeFlueEvent, { type: 'turn_request' }>;
void _;

// Direct-agent prompts (`?wait=result`) always resolve with the runtime
// `PromptResponse`; the SDK duplicates the shape so it must stay assignable.
const _prompt: AgentPromptResponse = {} as RuntimePromptResponse;
void _prompt;

// The SDK duplicates `PromptUsage`; the shapes must stay mutually assignable.
const _usage: SdkPromptUsage = {} as RuntimePromptUsage;
const _usageBack: RuntimePromptUsage = {} as SdkPromptUsage;
void _usage;
void _usageBack;

// `GET /runs/:id?meta` serves the runtime `RunRecord`; the SDK duplicates the
// shape with no intentional widening, so it must stay mutually assignable.
const _run: SdkRunRecord = {} as RuntimeRunRecord;
const _runBack: RuntimeRunRecord = {} as SdkRunRecord;
void _run;
void _runBack;

// The SDK duplicates the image-redaction sentinel; both constants are literal
// string types, so these assignments fail if the values ever diverge.
const _sentinel: typeof RUNTIME_IMAGE_DATA_OMITTED = SDK_IMAGE_DATA_OMITTED;
const _sentinelBack: typeof SDK_IMAGE_DATA_OMITTED = RUNTIME_IMAGE_DATA_OMITTED;
void _sentinel;
void _sentinelBack;
