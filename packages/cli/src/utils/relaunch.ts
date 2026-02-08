/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { RELAUNCH_EXIT_CODE } from './processUtils.js';
import { writeStderrLine } from './stdioHelpers.js';

export async function relaunchOnExitCode(runner: () => Promise<number>) {
  while (true) {
    try {
      const exitCode = await runner();

      if (exitCode !== RELAUNCH_EXIT_CODE) {
        process.exit(exitCode);
      }
    } catch (error) {
      process.stdin.resume();
      writeStderrLine('Fatal error: Failed to relaunch the CLI process.');
      writeStderrLine(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}

/**
 * Kills a child process tree. On Windows, uses `taskkill /f /t` to ensure
 * the entire process tree is terminated, preventing file locks on .exe files.
 */
function killChildProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (child.pid && !child.killed) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', child.pid.toString(), '/f', '/t']);
    } else {
      child.kill(signal);
    }
  }
}

export async function relaunchAppInChildProcess(
  additionalNodeArgs: string[],
  additionalScriptArgs: string[],
) {
  if (process.env['QWEN_CODE_NO_RELAUNCH']) {
    return;
  }

  const runner = () => {
    // process.argv is [node, script, ...args]
    // We want to construct [ ...nodeArgs, script, ...scriptArgs]
    const script = process.argv[1];
    const scriptArgs = process.argv.slice(2);

    const nodeArgs = [
      ...process.execArgv,
      ...additionalNodeArgs,
      script,
      ...additionalScriptArgs,
      ...scriptArgs,
    ];
    const newEnv = { ...process.env, QWEN_CODE_NO_RELAUNCH: 'true' };

    // The parent process should not be reading from stdin while the child is running.
    process.stdin.pause();

    const child = spawn(process.execPath, nodeArgs, {
      stdio: 'inherit',
      env: newEnv,
    });

    // Forward termination signals to the child process.
    // On Windows, signals are not automatically propagated to child processes,
    // which can leave them running and holding file locks on the .exe.
    const forwardSignal = (signal: NodeJS.Signals) => {
      killChildProcessTree(child, signal);
    };
    const onSigInt = () => forwardSignal('SIGINT');
    const onSigTerm = () => forwardSignal('SIGTERM');
    const onExit = () => killChildProcessTree(child);

    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    process.on('exit', onExit);

    return new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        // Remove signal handlers to prevent listener accumulation across
        // relaunch iterations.
        process.removeListener('SIGINT', onSigInt);
        process.removeListener('SIGTERM', onSigTerm);
        process.removeListener('exit', onExit);

        // Resume stdin before the parent process exits.
        process.stdin.resume();
        resolve(code ?? 1);
      });
    });
  };

  await relaunchOnExitCode(runner);
}
