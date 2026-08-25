// WHETHER THIS EXTENSION DOES ANYTHING IS A PROPERTY OF THE CLIENT BUILD, and
// the answer has already flipped once. `injectTtl` acts only on a cache_control
// block that carries no `ttl`, so a client that sets one itself makes every line
// below a no-op.
//
// Measured by grepping the client bundles, with a two-sided control on a 342MB
// binary (a string that must be present, one that must not):
//
//                     2.1.241   2.1.243
//     cache_control        99       144
//     ttl:"1h"              0         2      <- the emitter, minified
//     ttl:"5m"              0         3
//
// 2.1.241 does not carry the literal at all, so it cannot emit one: blocks
// arrive bare and this extension is load-bearing. 2.1.243 shipped an emitter
// (`subscriber ? {ttl:"1h"} : {ttl:"5m"}`, plus env overrides) which made this a
// no-op on every request — and was withdrawn from the release channel within
// hours. If a build carrying that emitter returns, this extension is redundant
// again, and nothing else will prompt anyone to check.
//
// Read the MINIFIED literal, not `"ttl"`. 2.1.241 has six of the latter and at
// least two are cache_control DOCUMENTATION — prose with a space after the
// colon. A bare count says 6 against 10 and reads as "241 has it too, just
// less", which is the opposite of the fact.
const TTL_MAIN = (process.env.CACHE_FIX_TTL_MAIN || "1h").toLowerCase();
const TTL_SUBAGENT = (process.env.CACHE_FIX_TTL_SUBAGENT || "1h").toLowerCase();
const AGENT_SDK_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

function detectRequestType(system) {
  if (!Array.isArray(system)) return "main";
  const isSubagent = system.some(
    (b) => b?.type === "text" && typeof b.text === "string" && b.text.startsWith(AGENT_SDK_PREFIX)
  );
  return isSubagent ? "subagent" : "main";
}

// Thinking and redacted_thinking blocks must be returned to the API byte-identical
// to the original model response — the API validates them and rejects any
// modification with "thinking blocks ... cannot be modified" (a 400 on the whole
// request). On Opus 4.7 interleaved thinking, CC can place a cache_control
// breakpoint on a thinking block; injecting a ttl there would mutate the block
// and break the request. Skip them — the marginal TTL benefit on one breakpoint
// is never worth corrupting a thinking turn.
const PROTECTED_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

function injectTtl(block, ttlParam) {
  if (block && PROTECTED_BLOCK_TYPES.has(block.type)) return block;
  if (block.cache_control?.type === "ephemeral" && !block.cache_control.ttl) {
    return { ...block, cache_control: { ...block.cache_control, ttl: ttlParam } };
  }
  return block;
}

export { detectRequestType, injectTtl };

export default {
  name: "ttl-management",
  description: "Inject correct TTL on cache_control markers based on detected tier",
  order: 500,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!body.system) return;

    const requestType = detectRequestType(body.system);
    const ttlValue = requestType === "subagent" ? TTL_SUBAGENT : TTL_MAIN;

    if (ttlValue === "none") return;

    // THE DETECTED-5m BRANCH IS NARROW, NOT DEAD, and it is worth saying which
    // because the obvious reading is the stronger one. `injectTtl` fires only on
    // a block with NO ttl, while the detector returns "5m" only when SOME block
    // HAS `ttl:"5m"` — so both hold together only in a MIXED payload, one block
    // tagged and another bare. On a uniform payload nothing injects at all.
    //
    // And on the client that actually runs today the detector cannot fire:
    // nothing upstream emits `ttl:"5m"` (see the bundle counts above), so the 5m
    // path is reached only by setting CACHE_FIX_TTL_MAIN/SUBAGENT. That is a
    // statement about this client build, not about the code — which is exactly
    // why it belongs beside the branch rather than in a test name.
    const detectedTier = ctx.meta?._ttlTier || "1h";
    const ttlParam = ttlValue === "5m" || detectedTier === "5m" ? "5m" : "1h";

    if (Array.isArray(body.system)) {
      body.system = body.system.map((block) => injectTtl(block, ttlParam));
    }

    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (let i = 0; i < msg.content.length; i++) {
          msg.content[i] = injectTtl(msg.content[i], ttlParam);
        }
      }
    }
  },
};
