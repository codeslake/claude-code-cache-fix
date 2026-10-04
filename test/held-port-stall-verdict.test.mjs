import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";

import { hit, verdict } from "./proc-helpers.mjs";

// A stalled runner is not a hung connection. When the runner's loop is blocked
// past the 3s clock of proxy-held-port's "serves every concurrent request", every
// timer fires ahead of the poll phase that would read the replies already on the
// sockets. Measured: "200 of 200 concurrent requests were not served: HUNG".
// The healthy server is in ANOTHER process, since one in this loop would stall too.
//
// ITS OWN FILE, ON PURPOSE: the check blocks the loop deliberately, and node runs
// each file in its own process. Inside proxy-held-port it left "fails loudly when
// the bind address can never work" with an empty stderr: red in 4 of 4 file-alone
// runs with the check present, 0 of 5 without it.
it("does not read a reply that arrived during a runner stall as HUNG", async () => {
  const srv = spawn(process.execPath, ["-e",
    `const s = require("http").createServer((q, r) => r.end("ok"));
     s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port)));
     process.stdin.on("end", () => process.exit()).resume();`],   // EOF: the runner is gone
  { stdio: ["pipe", "pipe", "inherit"] });
  try {
    const port = Number(await new Promise((r) => srv.stdout.once("data", r)));
    const reqs = Array.from({ length: 20 }, () => hit(port));
    const out = reqs.map((r) => verdict(r, 250));
    await Promise.all(reqs.map((r) => once(r, "finish")));   // every request is out
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    assert.deepEqual([...new Set(await Promise.all(out))], ["ok"], "every reply was already on its socket");
  } finally {
    srv.kill("SIGKILL");
  }
});
