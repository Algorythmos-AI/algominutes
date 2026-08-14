export const MAX_AUDIO_BYTES: number;
export const RATE_LIMIT_PER_HOUR: number;
export const RETRY_DEADLINE_MS: number;
export const MODEL_LADDER: readonly string[];

export function resolveGeminiAudioMime(hint?: string, storagePath?: string): string;
export function isValidId(id: unknown): id is string;
export function publicErrorFor(err: unknown): string;
export function validateSummaryShape(result: unknown): boolean;
export function isTransientError(err: unknown): boolean;
export function contextLineFor(type: string): string;
export function buildPromptText(type: string, content?: string): string;

export interface SummaryResult {
  gist: string;
  actionItems: string[];
  keyDecisions: string[];
  transcript: Array<{ speaker: string; text: string; time: string }>;
}

export function parseGeminiJson(rawText: string): SummaryResult;

export interface SummaryOnlyResult {
  gist: string;
  actionItems: string[];
  keyDecisions: string[];
}

export function buildSummaryPrompt(): string;
export const SUMMARY_RESPONSE_SCHEMA: Record<string, unknown>;
export function validateSummaryOnlyShape(result: unknown): boolean;
export function parseSummaryJson(rawText: string): SummaryOnlyResult;

export function sleep(ms: number): Promise<void>;
export function backoffMs(attempt: number): number;
