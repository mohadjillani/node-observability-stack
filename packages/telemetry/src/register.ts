/**
 * Entry point for `node --import @mohadjillani/telemetry/register app.js`.
 *
 * ESM applications need a loader hook for the instrumentation to see their
 * imports (a `require` hook alone only covers CommonJS). The hook is
 * registered first, the SDK second, and the process waits until the loader
 * has acknowledged every module the instrumentation asked to wrap, so the
 * application's own imports — which start right after this file — are all
 * patched.
 *
 * Setting `OTEL_SDK_DISABLED=true` skips the SDK and the loader hook, which
 * is what the overhead measurement compares against.
 */
import { register } from 'node:module';
import { createAddHookMessageChannel } from 'import-in-the-middle';
import { startTelemetry } from './sdk.js';

if ((process.env.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() !== 'true') {
  const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);
  startTelemetry();
  await waitForAllMessagesAcknowledged();
}
