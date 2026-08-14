import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { randomToken } from "./crypto.js";
import { runRecoveryCli } from "./recovery.js";
import { installGracefulShutdown } from "./shutdown.js";

async function main(): Promise<void> {
  const recoveryExitCode = await runRecoveryCli(process.argv.slice(2));
  if (recoveryExitCode != null) {
    process.exitCode = recoveryExitCode;
    return;
  }

  const config = loadConfig();
  let generatedSetupToken: string | null = null;
  if (config.setupToken == null) {
    generatedSetupToken = randomToken(24);
    config.setupToken = generatedSetupToken;
  }
  const app = await buildApp({ config });

  const publicBind = config.host === "0.0.0.0" || config.host === "::";
  if (
    publicBind &&
    !config.cookieSecure &&
    !config.trustProxy &&
    !config.allowInsecurePublic
  ) {
    app.log.warn(
      "SECURITY WARNING: the server is listening on every interface without secure cookies or a trusted HTTPS proxy. Use the Caddy compose profile, or set DS_SERVER_ALLOW_INSECURE_PUBLIC=true only for an intentional private-network HTTP deployment.",
    );
  }
  if (generatedSetupToken != null) {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    const body = health.json<{ setupRequired?: boolean }>();
    if (body.setupRequired === true) {
      app.log.warn(
        `FIRST-RUN OWNER SETUP TOKEN: ${generatedSetupToken}`,
      );
    }
  }

  const removeShutdownHandlers = installGracefulShutdown(app);
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`DebridStreamer server listening on http://${config.host}:${config.port}`);
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
    removeShutdownHandlers();
    await app.close().catch((closeError: unknown) => {
      app.log.error(closeError);
    });
  }
}

void main();
