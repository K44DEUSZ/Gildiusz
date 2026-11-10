import type { JobErrorCode } from "../../contracts/jobs.js";
export * from "../../contracts/jobs.js";

export class JobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message = code as string,
  ) {
    super(message);
    this.name = "JobError";
  }
}
