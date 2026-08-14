import type { FastifyInstance } from "fastify";

type ShutdownSignal = "SIGINT" | "SIGTERM";

interface SignalRuntime {
  exitCode?: string | number | null;
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
}

/** Close Fastify on container and terminal shutdown so every onClose hook runs,
 * including the database lock cleanup and active transcode termination. */
export function installGracefulShutdown(
  app: Pick<FastifyInstance, "close" | "log">,
  runtime: SignalRuntime = process,
): () => void {
  let shutdownStarted = false;
  const requestShutdown = (signal: ShutdownSignal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    app.log.info({ signal }, "Graceful server shutdown started.");
    void Promise.resolve()
      .then(() => app.close())
      .catch((error: unknown) => {
        runtime.exitCode = 1;
        app.log.error({ err: error, signal }, "Graceful server shutdown failed.");
      });
  };
  const onSigint = () => requestShutdown("SIGINT");
  const onSigterm = () => requestShutdown("SIGTERM");
  runtime.once("SIGINT", onSigint);
  runtime.once("SIGTERM", onSigterm);
  return () => {
    runtime.removeListener("SIGINT", onSigint);
    runtime.removeListener("SIGTERM", onSigterm);
  };
}
