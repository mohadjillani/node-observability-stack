import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export type LogLine = Record<string, unknown> & { msg?: string };

export interface ServiceProcess {
  readonly name: string;
  readonly logs: readonly LogLine[];
  /** Resolves with the first log line whose `msg` matches. */
  waitForLog(msg: string, timeoutMs?: number): Promise<LogLine>;
  /** SIGTERM, then the exit code. */
  stop(): Promise<number | null>;
}

/**
 * Runs a built service exactly as the image does: `node --import
 * @mohadjillani/telemetry/register services/<name>/dist/main.js`, with its
 * JSON log lines captured for assertions.
 */
export function startService(name: 'api' | 'worker', env: NodeJS.ProcessEnv): ServiceProcess {
  const logs: LogLine[] = [];
  const stderr: string[] = [];
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', '@mohadjillani/telemetry/register', `services/${name}/dist/main.js`],
    {
      cwd: repoRoot,
      env: { ...process.env, OTEL_SERVICE_NAME: name, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        logs.push(JSON.parse(line) as LogLine);
      } catch {
        stderr.push(`[${name} stdout, not json] ${line}`);
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(`[${name} stderr] ${chunk.toString().trimEnd()}`);
  });

  const exited = once(child, 'exit').then(([code]) => code as number | null);

  return {
    name,
    logs,
    async waitForLog(msg, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = logs.find((line) => line.msg === msg);
        if (found) return found;
        if (child.exitCode !== null) {
          throw new Error(
            `${name} exited with ${String(child.exitCode)} before "${msg}"\n${stderr.join('\n')}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(`${name} never logged "${msg}"\n${stderr.join('\n')}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      const code = await exited;
      if (stderr.length > 0) console.error(stderr.join('\n'));
      return code;
    },
  };
}
