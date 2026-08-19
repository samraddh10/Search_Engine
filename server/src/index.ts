import app, { suggestIndex } from "./api/server.js";
import { config } from "./config.js";
import { closePg } from "./db/pg.js";
import { closeRedis, connectRedis } from "./db/redis.js";

// If a client holds a keep-alive connection open, server.close() waits for it forever.
// Hosting platforms send SIGTERM and then hard-kill after a grace period, so bound our
// own wait and exit non-zero rather than hanging until we're killed.
const FORCE_EXIT_MS = 10_000;

async function main() {
  //no-op when REDIS_URL isn't set — see db/redis.ts for why that's a valid state
  await connectRedis();

  const server = app.listen(config.PORT, () => {
    console.log(`Server listening on http://localhost:${config.PORT}`);
  });

  //Deliberately not awaited: the first person to type gets a warm index, and `listen` never
  //waits on Postgres to accept traffic. The `.catch` is what keeps a failed startup read from
  //becoming an unhandled rejection — `suggest()` will rebuild on demand anyway.
  void suggestIndex.refresh().catch((err: unknown) => {
    console.error("Failed to warm the suggest index; it will build on first use", err);
  });

  //A second Ctrl-C while the first shutdown is still draining would run this twice, and
  //the second closePg() rejects with "Called end on pool more than once".
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("Shutting down...");

    const forceExit = setTimeout(() => {
      console.error(`Shutdown exceeded ${FORCE_EXIT_MS}ms — forcing exit`);
      process.exit(1);
    }, FORCE_EXIT_MS);
    //don't let this timer itself keep the process alive once shutdown finishes early
    forceExit.unref();

    try {
      //server.close() stops accepting new connections immediately, but only fires its
      //callback once in-flight requests have finished. Awaiting that callback is what
      //makes this graceful — close it without waiting and the Postgres pool can be torn
      //down underneath a request that is still running a query.
      await new Promise<void>((resolve) => server.close(() => resolve()));

      //no dependency between closing Postgres and Redis, so close them concurrently
      await Promise.all([closePg(), closeRedis()]);

      process.exit(0);
    } catch (err) {
      //nothing awaits a signal handler, so without this catch a failure to close either
      //connection becomes an unhandled rejection and the process hangs instead of exiting
      console.error("Error during shutdown", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
//This is why main() was wrapped as its own function rather than run inline:
//main() returns a Promise, and if anything inside it throws — most likely,
//await connectRedis() failing because a *configured* Redis isn't reachable —
//that rejection is caught here explicitly. It logs the real error and exits with code 1
main().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});
