// Loaded with `node --import` into a signerd that a test starts, and into nothing else.
//
// signerd reads its chain provider at fixed https URLs (Koios, per network), and starts reading at
// once. For a test those must reach the fake on 127.0.0.1 and nothing else: this sends the Koios
// URLs there (FAKE_KOIOS_URL), and makes any other connection to anything but the loopback throw,
// whoever opens it, so a test that went wrong fails instead of reaching a real provider.
import net from "node:net";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const fake = process.env.FAKE_KOIOS_URL;
if (!fake) throw new Error("localOnly: FAKE_KOIOS_URL is not set");

const LOCAL = new Set(["127.0.0.1", "::1", "localhost"]);
const KOIOS = /^https:\/\/(?:api|preprod|preview)\.koios\.rest\/api\/v1(\/[^?#]*)?(\?[^#]*)?$/;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const m = KOIOS.exec(url);
  if (m) {
    const to = `${fake}${m[1] ?? ""}${m[2] ?? ""}`;
    return realFetch(typeof input === "object" && !(input instanceof URL) ? new Request(to, input) : to, init);
  }
  if (LOCAL.has(new URL(url).hostname.replace(/^\[|\]$/g, ""))) return realFetch(input, init);
  return Promise.reject(new Error(`localOnly: refusing to fetch ${url}`));
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  const host = o && typeof o === "object" ? (o.path ? "localhost" : (o.host ?? "localhost")) : typeof args[1] === "string" ? args[1] : "localhost";
  if (!LOCAL.has(host)) throw new Error(`localOnly: refusing to connect to ${host}`);
  return connect.apply(this, args);
};

// Windows has no mode bits for signerd to read, so it reports that it could not check. With
// FAKE_MODES ({ "<path>": <mode> }) the child instead sees a POSIX host whose files have those modes
// (0600 for any file not listed), which lets the same cases run on every platform. signerd reads
// process.platform for this and nowhere else. Never set on a POSIX host, where the modes are real.
if (process.env.FAKE_MODES) {
  const modes = JSON.parse(process.env.FAKE_MODES);
  Object.defineProperty(process, "platform", { value: "linux" });
  const stat = fs.statSync;
  fs.statSync = function (path, ...rest) {
    const real = stat.call(this, path, ...rest);
    if (!real || typeof real.mode !== "number" || typeof path !== "string") return real;
    const seen = Object.assign(Object.create(Object.getPrototypeOf(real)), real);
    seen.mode = (real.mode & ~0o777) | (modes[path] ?? 0o600);
    return seen;
  };
  syncBuiltinESMExports();
}
