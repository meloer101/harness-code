/**
 * Browser-safe subset of core: pure functions with no `node:*` imports,
 * published as the `@harness-code/core/browser` subpath so `packages/web`
 * (and, later, an Electron renderer) can import them directly instead of
 * reimplementing tool-summary and token/cost formatting.
 *
 * Everything here must stay free of Node built-ins transitively — `browser.
 * bundle.test.ts` proves that by bundling this exact entry point with esbuild
 * `platform: 'browser'` and failing if one sneaks in. Adding an export here
 * pulls its whole module graph into that check, so keep this file's imports
 * limited to modules that are themselves dependency-free.
 */

export { describeToolInput } from './tools/util.js';
export { fmtTokens, fmtUSD } from './util/format.js';

export type { TranscriptItem } from './agent/session.js';
export type {
  ContentBlock,
  Message,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from './provider/types.js';
