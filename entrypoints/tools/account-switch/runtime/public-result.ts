import type { RunSpecResult, SpecOpTrace, TrialSignalState } from "./run-spec";

export interface PublicRunResult {
  success: boolean;
  trace: SpecOpTrace[];
  error?: string;
  errorCode?: string;
  trialSignals?: TrialSignalState[];
}

export function toPublicRunResult(result: RunSpecResult): PublicRunResult {
  return {
    success: result.success,
    trace: result.trace,
    ...(!result.success ? { error: result.error, errorCode: result.errorCode } : {}),
    ...(result.trialSignals ? { trialSignals: result.trialSignals } : {}),
  };
}
