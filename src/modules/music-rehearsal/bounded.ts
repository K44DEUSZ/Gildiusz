import { RehearsalError, type RehearsalErrorCode, type RehearsalScheduler } from "./types.js";

export const nativeScheduler: RehearsalScheduler = {
  after(milliseconds, callback) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};
export function checkpoint(signal: AbortSignal): void {
  if (signal.aborted) throw new RehearsalError("cancelled");
}
export async function bounded<T>(
  scheduler: RehearsalScheduler,
  milliseconds: number,
  code: RehearsalErrorCode,
  parent: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  checkpoint(parent);
  const controller = new AbortController();
  let rejectAbort: (error: RehearsalError) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAbort(new RehearsalError("cancelled"));
  };
  parent.addEventListener("abort", abort, { once: true });
  const cancel = scheduler.after(milliseconds, () => {
    controller.abort();
    rejectAbort(new RehearsalError(code));
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        checkpoint(controller.signal);
        return work(controller.signal);
      }),
      aborted,
    ]);
  } finally {
    cancel();
    parent.removeEventListener("abort", abort);
  }
}
export function safeCode(error: unknown, fallback: RehearsalErrorCode): RehearsalErrorCode {
  return error instanceof RehearsalError ? error.code : fallback;
}
