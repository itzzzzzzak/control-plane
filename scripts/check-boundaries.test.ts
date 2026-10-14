import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

// @ts-expect-error plain .mjs script without types
import { findViolations } from "../../scripts/check-boundaries.mjs"

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cp-boundaries-"))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

test("using another module through its index is allowed", () => {
  const root = repo({
    "modules/a/index.ts": "export const a = 1",
    "modules/b/index.ts": 'import { a } from "../a/index.js"\nexport const b = a',
    "apps/server/src/main.ts": 'import { b } from "../../../modules/b/index.js"\nconsole.log(b)',
  })
  assert.deepEqual(findViolations(root), [])
})

test("reaching into another module's internals is a violation", () => {
  const root = repo({
    "modules/a/index.ts": "export {}",
    "modules/a/secret.ts": "export const s = 1",
    "modules/b/index.ts": 'import { s } from "../a/secret.js"\nexport const b = s',
  })
  const v = findViolations(root)
  assert.equal(v.length, 1)
  assert.match(v[0]!, /modules\/b\/index\.ts.*reach into "a"/)
})

test("the server app may not reach into internals either; dynamic imports are checked too", () => {
  const root = repo({
    "modules/a/index.ts": "export {}",
    "modules/a/deep/x.ts": "export const x = 1",
    "apps/server/src/main.ts": 'const m = await import("../../../modules/a/deep/x.js")\nvoid m',
  })
  assert.equal(findViolations(root).length, 1)
})

test("a module may import its own internals freely, and packages are ignored", () => {
  const root = repo({
    "modules/a/index.ts": 'import { x } from "./deep/x.js"\nimport { test } from "node:test"\nexport { x, test }',
    "modules/a/deep/x.ts": "export const x = 1",
  })
  assert.deepEqual(findViolations(root), [])
})
