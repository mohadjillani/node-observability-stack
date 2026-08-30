/**
 * Entry point for `node --import @mohadjillani/telemetry/register app.js`.
 *
 * ESM applications need a loader hook for the instrumentation to see their
 * imports (a `require` hook alone only covers CommonJS). On Node 22.22.3+ and
 * 24.11.1+ the hook runs synchronously on the application thread through
 * `module.registerHooks`, which needs no handshake: instrumentations register
 * their module list and the loader sees it directly. Older versions get the
 * asynchronous loader thread via `module.register`, where the process waits
 * until that thread has acknowledged every module the instrumentation asked
 * to wrap before the application's own imports start.
 *
 * Either way the hook is installed first and the SDK second, so everything
 * the application imports is patched. `OTEL_SDK_DISABLED=true` skips both,
 * which is what the overhead measurement compares against.
 */
import { register } from 'node:module';
import { createAddHookMessageChannel } from 'import-in-the-middle';
import {
  register as registerSyncHooks,
  supportsSyncHooks,
} from 'import-in-the-middle/register-hooks.mjs';
import { createInstrumentations, instrumentedModules, startTelemetry } from './sdk.js';

if ((process.env.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() !== 'true') {
  const instrumentations = createInstrumentations();
  if (supportsSyncHooks()) {
    registerSyncHooks({ include: instrumentedModules(instrumentations) });
    startTelemetry({ instrumentations });
  } else {
    const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
    register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);
    startTelemetry({ instrumentations });
    await waitForAllMessagesAcknowledged();
  }
}
