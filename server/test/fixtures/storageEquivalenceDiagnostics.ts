type EquivalenceStage =
  | "admission"
  | "observer-identity"
  | "native-descriptor"
  | "reference-descriptor"
  | "descriptor-comparison"
  | "projection-observation"
  | "projection-comparison";

/** Retain the failing step without copying subprocess messages, paths or ACLs. */
export function storageEquivalenceStep<T>(stage: EquivalenceStage, run: () => T): T {
  try {
    return run();
  } catch (error) {
    const subprocess = error instanceof Error
      ? error as Error & { code?: unknown; status?: unknown }
      : undefined;
    let category = "assertion-or-unclassified";
    switch (subprocess?.code) {
      case "ETIMEDOUT":
        category = "timeout";
        break;
      case "ENOENT":
        category = "not-found";
        break;
      case "EACCES":
      case "EPERM":
        category = "access-denied";
        break;
      case "ENOBUFS":
        category = "output-limit";
        break;
      default:
        if (typeof subprocess?.status === "number" && Number.isInteger(subprocess.status) && subprocess.status !== 0) {
          category = "nonzero-exit";
        }
    }
    // Never attach the original message, process output, assertion data or cause.
    throw new Error(`Native descriptor equivalence failed at ${stage} (${category}). Raw observations were not retained.`);
  }
}
