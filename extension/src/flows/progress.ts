/**
 * Thin progress emitter — forwards a step name to the SW which forwards
 * to the backend WS as a wire ProgressEvent. Fire-and-forget; ignores
 * failures (progress is best-effort, never breaks a flow).
 */
import type { ProgressForward } from '../content-protocol.js';

export async function reportProgress(
  commandId: string,
  step: string,
  detail?: string,
): Promise<void> {
  const msg: ProgressForward = {
    kind: 'progress.forward',
    commandId,
    step,
    ...(detail !== undefined ? { detail } : {}),
  };
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
    /* SW may be tearing down — ignore */
  }
}
