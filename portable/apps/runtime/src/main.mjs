import { startLocalRuntime } from "./server.mjs";

try {
  const runtime = await startLocalRuntime();
  process.stdout.write(`All-Round-AI runtime (${runtime.profile}): ${runtime.url}/login\n`);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.close();
      process.stdout.write(`All-Round-AI stopped (${signal})\n`);
    } catch (error) {
      process.stderr.write(`All-Round-AI shutdown failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.includes("\n")) {
      const command = input.split("\n", 1)[0].trim();
      input = input.slice(input.indexOf("\n") + 1);
      if (command === "shutdown") void stop("stdin");
    }
  });
} catch (error) {
  process.stderr.write(`All-Round-AI failed to start: ${error.message}\n`);
  process.exitCode = 1;
}
