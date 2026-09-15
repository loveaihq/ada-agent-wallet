import { createServer } from "node:net";

/**
 * A port nothing is listening on, from the OS.
 *
 * The dev checks each spawn their own signerd, and fixed ports meant that running one twice in
 * quick succession could reach the previous run's process or fail to bind at all — which surfaced
 * as a connection reset in the middle of a check and looked exactly like a failure. Twice.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const bound = probe.address();
      const port = typeof bound === "object" && bound ? bound.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("could not get a free port"))));
    });
  });
}
