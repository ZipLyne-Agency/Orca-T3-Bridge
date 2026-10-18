export class BridgeError extends Error {
  constructor(readonly code: string, message: string, readonly deliveryUnknown = false) {
    super(message);
    this.name = "BridgeError";
  }
}

export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string") return error.code;
  return "bridge_failure";
}

/** Never include raw transport errors: they can contain tokens, prompts, or tool output. */
export function publicError(error: unknown): string {
  return error instanceof BridgeError ? error.message : `Bridge operation failed (${errorCode(error)}).`;
}
