import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The git-status recommendation used to claim CC re-renders `git status` into
// the system prompt on every call, so any file edit busts the entire prefix
// cache. Since Claude Code 2.1.267 the system prompt is recorded once per
// session and reused (CHANGELOG 2.1.267/2.1.269), measured frozen across a
// tracked-file edit on 2.1.268 and 2.1.270. The section must carry the version
// qualifier and drop the unqualified present-tense claim.
const files = [
  "README.md",
  "README.ko.md",
  "README.fr.md",
  "README.zh.md",
  "docs/extension-impact-guide.md",
];

// Fenced code blocks are exempt: they may legitimately show old flag output,
// not the prose claim under test.
const prose = (t) => t.replace(/```[\s\S]*?```/g, "");

function gitStatusSection(text) {
  const lines = text.split("\n");
  const headingRe = /^#{1,6}\s/;
  const start = lines.findIndex((l) => headingRe.test(l) && /git-status/i.test(l));
  assert.ok(start >= 0, "no heading matching /git-status/i found");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("the git-status section names the 2.1.267 version qualifier and drops the unqualified per-edit-bust claim", () => {
  for (const f of files) {
    const text = prose(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    const section = gitStatusSection(text);
    assert.ok(section.includes("2.1.267"),
      `${f}: git-status section does not mention 2.1.267`);
    assert.ok(!section.includes("which busts the entire prefix cache"),
      `${f}: git-status section still carries the unqualified present-tense claim`);
  }
});
