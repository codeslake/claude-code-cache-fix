// With extensions loaded, handleMessages and handleBootstrap re-serialise the
// upstream JSON body (JSON.stringify(resCtx.body)) but used to keep upstream's
// content-length. A pretty-printed upstream body is then shorter on the wire
// than its declared length (the client waits for bytes that never come), a
// body whose re-serialisation grows (1e21 -> 1e+21) is longer (client parse
// error). Every other fixture answers chunked, which is why nothing caught it.
// A mock upstream with an explicit content-length is what exposes it. The
// pooled-key rewrite (a first 429 for a pool.fp key answered as 401, the raw
// upstream bytes sent) goes through the same write, so its three outcomes are
// pinned here too.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../proxy/server.mjs";

const PRETTY = JSON.stringify({ type: "message", content: [{ type: "text", text: "héllo" }] }, null, 2);
const GROWS = '{"n":1e21}';
// Pretty-printed and error-shaped, like the 429 the pool rewrite sees.
const RATE_429 = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" }, request_id: "req_rate" }, null, 2);
const helperOf = (key, session) => ({ "x-api-key": key, authorization: `Bearer ${key}`, "x-claude-code-session-id": session });

let handle, upstream, extDir, stateDir, savedXdg, upstreamStatus, upstreamBody;

function clientRequest(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: handle.port, path, method: "POST", agent: false,
        headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("error", reject);
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error("client timed out waiting for the declared content-length")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("proxy server re-serialised JSON body carries its own content-length", () => {
  before(async () => {
    extDir = await mkdtemp(join(tmpdir(), "content-length-ext-"));
    await writeFile(join(extDir, "extensions.json"), "{}");
    // Any loaded extension routes the response through the re-serialising branch.
    await writeFile(join(extDir, "noop.mjs"), `export default { name: "noop", onResponse() {} };`);
    // select-key's pool.fp: one sha256 hex line per pooled key.
    stateDir = await mkdtemp(join(tmpdir(), "content-length-pool-"));
    await mkdir(join(stateDir, "claude-api-key"));
    await writeFile(join(stateDir, "claude-api-key", "pool.fp"),
      ["sk-pool-first", "sk-pool-repeat"].map((k) => createHash("sha256").update(k).digest("hex") + "\n").join(""));
    savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;

    upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(upstreamStatus, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(upstreamBody),
        });
        res.end(upstreamBody);
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    handle = await startProxy({ port: 0, watch: false, extensionsDir: extDir, extensionsConfig: join(extDir, "extensions.json") });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedXdg;
    await rm(extDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  for (const [name, path, status, body, reqBody] of [
    ["/v1/messages 200, pretty-printed upstream", "/v1/messages", 200, PRETTY, { model: "test", messages: [] }],
    ["/v1/messages 429, pretty-printed upstream", "/v1/messages", 429, PRETTY, { model: "test", messages: [] }],
    ["/v1/messages 200, re-serialisation grows the body", "/v1/messages", 200, GROWS, { model: "test", messages: [] }],
    ["bootstrap 200, pretty-printed upstream", "/api/claude_cli/bootstrap", 200, PRETTY, { version: "2.1.150" }],
    ["bootstrap 200, re-serialisation grows the body", "/api/claude_cli/bootstrap", 200, GROWS, { version: "2.1.150" }],
  ]) {
    it(`${name}: client body parses and matches content-length`, async () => {
      upstreamStatus = status;
      upstreamBody = body;
      const res = await clientRequest(path, reqBody);
      assert.equal(res.status, status);
      assert.deepEqual(JSON.parse(res.body.toString()), JSON.parse(body));
      assert.equal(Number(res.headers["content-length"]), res.body.length);
    });
  }

  async function ask429(headers) {
    upstreamStatus = 429;
    upstreamBody = RATE_429;
    return clientRequest("/v1/messages", { model: "test", messages: [] }, headers);
  }

  function assertWhole(res, status) {
    assert.equal(res.status, status);
    assert.deepEqual(JSON.parse(res.body.toString()), JSON.parse(RATE_429));
    assert.equal(Number(res.headers["content-length"]), res.body.length);
  }

  it("an OAuth Bearer 429 (no x-api-key) arrives whole", async () => {
    assertWhole(await ask429({ authorization: "Bearer oauth-token" }), 429);
  });

  it("a pooled helper key's repeat 429 in the same session inside its window passes as 429, whole", async () => {
    const headers = helperOf("sk-pool-repeat", "s-repeat");
    assert.equal((await ask429(headers)).status, 401);
    assertWhole(await ask429(headers), 429);
  });

  it("a pooled helper key's first 429 is answered 401 with the upstream bytes untouched", async () => {
    const res = await ask429(helperOf("sk-pool-first", "s-first"));
    assert.equal(res.status, 401);
    assert.equal(res.body.toString(), RATE_429);
    assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(RATE_429));
  });
});
