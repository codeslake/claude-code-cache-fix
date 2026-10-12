// An API-key org whose credit is spent gets a 400 from upstream. Claude Code
// re-runs apiKeyHelper only on 401/403, never on 400, so handleMessages'
// buffered branch answers that one 400 as 401 (body and headers untouched).
// Claude Code sends the helper's key in x-api-key AND as Authorization: Bearer
// <same key>, so that pair counts as an API-key request. Everything else
// (OAuth Bearer, other 400s, other statuses) passes as-is.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../proxy/server.mjs";

// Non-compact on purpose: a JSON.parse/stringify round trip would change it.
const CREDIT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "billing_error",
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
  request_id: "req_credit",
}, null, 2);
const OTHER_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } });
const OK_200 = JSON.stringify({ type: "message", content: [] });

function clientRequest(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "test", messages: [] }));
  });
}

describe("API-key credit-balance 400 is answered as 401", () => {
  let handle, upstream, reply;

  before(async () => {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(reply.status, { "content-type": "application/json", "x-should-retry": "false" });
        res.end(reply.body);
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    handle = await startProxy({ port: 0, watch: false });
  });

  after(async () => {
    await handle.close();
    await new Promise((r) => upstream.close(r));
    delete process.env.CACHE_FIX_PROXY_UPSTREAM;
  });

  async function ask(status, body, headers) {
    reply = { status, body };
    return clientRequest(handle.port, headers);
  }

  it("x-api-key + credit 400 -> 401, body byte-identical, headers unchanged", async () => {
    const res = await ask(400, CREDIT_BODY, { "x-api-key": "sk-ant-test" });
    assert.equal(res.status, 401);
    assert.equal(res.body.toString(), CREDIT_BODY);
    assert.equal(res.headers["x-should-retry"], "false");
    assert.equal(res.headers["content-type"], "application/json");
  });

  it("x-api-key + Authorization: Bearer <same key> + credit 400 -> 401, body byte-identical", async () => {
    const res = await ask(400, CREDIT_BODY, { "x-api-key": "sk-ant-test", authorization: "Bearer sk-ant-test" });
    assert.equal(res.status, 401);
    assert.equal(res.body.toString(), CREDIT_BODY);
  });

  it("a Bearer request keeps its 400 unless its Bearer is the x-api-key", async () => {
    for (const headers of [{ authorization: "Bearer x" }, { authorization: "Bearer x", "x-api-key": "sk-ant-test" }]) {
      const res = await ask(400, CREDIT_BODY, headers);
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.body), JSON.parse(CREDIT_BODY));
    }
  });

  it("x-api-key + another 400 body keeps its 400", async () => {
    const res = await ask(400, OTHER_400, { "x-api-key": "sk-ant-test" });
    assert.equal(res.status, 400);
    assert.equal(res.body.toString(), OTHER_400);
  });

  it("x-api-key + 200 is untouched", async () => {
    const res = await ask(200, OK_200, { "x-api-key": "sk-ant-test" });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), OK_200);
  });
});
