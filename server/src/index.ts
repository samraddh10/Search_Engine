import app from "./api/server.js";
import { config } from "./config.js";
import { closePg } from "./db/pg.js";
import { closeRedis, connectRedis } from "./db/redis.js";

async function main() {
  //no-op when REDIS_URL isn't set — see db/redis.ts for why that's a valid state
  await connectRedis();

  const server = app.listen(config.PORT, () => {
    console.log(`Server listening on http://localhost:${config.PORT}`);
  });

  const shutdown = async () => {
    console.log("Shutting down...");
    //stops http server from accepting new incoming connections
    server.close();
    //only after the server has stopped taking new work does it close both database connections.
    //Promise.all runs them concurrently rather than one after another
    //as there's no dependency between closing Postgres and closing Redis,
    await Promise.all([closePg(), closeRedis()]);
    //explicitly ends the Node process with exit code 0.
    process.exit(0);
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
