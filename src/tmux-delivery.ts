import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TmuxCommandResult {
  stdout: string;
  stderr: string;
}

export type TmuxCommandRunner = (args: readonly string[]) => Promise<TmuxCommandResult>;

export interface TmuxDeliveryInput {
  paneId: string;
  text: string;
}

export interface TmuxDeliveryResult {
  status: 'delivered';
  paneId: string;
  text: string;
  captureBefore: string;
  captureAfter: string;
  verified: true;
  submitted: true;
}

export type TmuxDeliveryErrorCode =
  | 'invalid-input'
  | 'capture-before-failed'
  | 'type-failed'
  | 'capture-after-failed'
  | 'verification-failed'
  | 'submit-failed';

export type TmuxDeliveryStage =
  | 'validate'
  | 'capture-before'
  | 'type'
  | 'capture-after'
  | 'verify'
  | 'submit';

export class TmuxDeliveryError extends Error {
  constructor(
    message: string,
    public readonly code: TmuxDeliveryErrorCode,
    public readonly stage: TmuxDeliveryStage,
    public readonly paneId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TmuxDeliveryError';
  }
}

export async function runTmuxCommand(args: readonly string[]): Promise<TmuxCommandResult> {
  const { stdout, stderr } = await execFileAsync('tmux', [...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return { stdout, stderr };
}

function validateInput(input: TmuxDeliveryInput): TmuxDeliveryInput {
  const paneId = input.paneId.trim();
  if (!paneId) {
    throw new TmuxDeliveryError(
      'tmux pane id cannot be empty',
      'invalid-input',
      'validate',
      input.paneId,
    );
  }
  if (!input.text.trim()) {
    throw new TmuxDeliveryError(
      'tmux delivery text cannot be empty',
      'invalid-input',
      'validate',
      paneId,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(input.text)) {
    throw new TmuxDeliveryError(
      'tmux delivery text cannot contain control characters',
      'invalid-input',
      'validate',
      paneId,
    );
  }
  return { paneId, text: input.text };
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string }).stderr?.trim();
  return stderr || error.message;
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let start = 0;
  while (true) {
    const index = value.indexOf(search, start);
    if (index === -1) return count;
    count += 1;
    start = index + search.length;
  }
}

function compactForTerminalWrap(value: string): string {
  return value.replace(/\s+/gu, '');
}

function countVisibleOccurrences(value: string, search: string): number {
  const exact = countOccurrences(value, search);
  if (exact > 0) return exact;
  return countOccurrences(compactForTerminalWrap(value), compactForTerminalWrap(search));
}

async function runStage(
  runner: TmuxCommandRunner,
  args: readonly string[],
  details: {
    paneId: string;
    code: Exclude<TmuxDeliveryErrorCode, 'invalid-input' | 'verification-failed'>;
    stage: Exclude<TmuxDeliveryStage, 'validate' | 'verify'>;
    action: string;
  },
): Promise<TmuxCommandResult> {
  try {
    return await runner(args);
  } catch (error) {
    throw new TmuxDeliveryError(
      `Failed to ${details.action} tmux pane ${details.paneId}: ${errorMessage(error)}`,
      details.code,
      details.stage,
      details.paneId,
      { cause: error },
    );
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function deliverTmuxMessage(
  input: TmuxDeliveryInput,
  runner: TmuxCommandRunner = runTmuxCommand,
): Promise<TmuxDeliveryResult> {
  const { paneId, text } = validateInput(input);
  const captureBefore = (await runStage(
    runner,
    ['capture-pane', '-p', '-J', '-t', paneId],
    {
      paneId,
      code: 'capture-before-failed',
      stage: 'capture-before',
      action: 'read',
    },
  )).stdout;

  await runStage(
    runner,
    ['send-keys', '-l', '-t', paneId, '--', text],
    {
      paneId,
      code: 'type-failed',
      stage: 'type',
      action: 'type into',
    },
  );

  await wait(150);

  const captureAfter = (await runStage(
    runner,
    ['capture-pane', '-p', '-J', '-t', paneId],
    {
      paneId,
      code: 'capture-after-failed',
      stage: 'capture-after',
      action: 'verify',
    },
  )).stdout;

  if (countVisibleOccurrences(captureAfter, text) <= countVisibleOccurrences(captureBefore, text)) {
    throw new TmuxDeliveryError(
      `Could not verify text in tmux pane ${paneId}; Enter was not pressed`,
      'verification-failed',
      'verify',
      paneId,
    );
  }

  await runStage(
    runner,
    ['send-keys', '-t', paneId, 'Enter'],
    {
      paneId,
      code: 'submit-failed',
      stage: 'submit',
      action: 'press Enter in',
    },
  );

  return {
    status: 'delivered',
    paneId,
    text,
    captureBefore,
    captureAfter,
    verified: true,
    submitted: true,
  };
}
