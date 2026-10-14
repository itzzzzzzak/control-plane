// Enforces the modular-monolith rule: a module may use another module ONLY through that module's public entry
// (modules/<name>/index.ts). Reaching into another module's internals fails the build.
//   node scripts/check-boundaries.mjs [rootDir]
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

export function findViolations(root) {
  const modulesDir = join(root, "modules")
  const moduleOf = (file) => {
    const rel = relative(modulesDir, file)
    return rel.startsWith("..") ? null : rel.split(sep)[0]
  }
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|mts)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(full)
    }
  }
  for (const top of ["apps", "modules"]) {
    try { walk(join(root, top)) } catch { /* folder may not exist yet */ }
  }
  const violations = []
  const importRe = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g
  for (const file of files) {
    const from = moduleOf(file)
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(importRe)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (!spec || !spec.startsWith(".")) continue
      const target = resolve(dirname(file), spec.replace(/\.js$/, ""))
      const to = moduleOf(target)
      if (to === null || to === from) continue // outside modules/, or inside the same module
      const entry = join(modulesDir, to, "index")
      if (target !== entry && target !== join(modulesDir, to)) {
        violations.push(`${relative(root, file)} imports ${spec}: reach into "${to}" through modules/${to}/index.ts only`)
      }
    }
  }
  return violations
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(process.argv[2] ?? ".")
  const violations = findViolations(root)
  if (violations.length > 0) {
    console.error(`Module boundary violations:\n${violations.map((v) => `  - ${v}`).join("\n")}`)
    process.exit(1)
  }
  console.log("module boundaries ok")
}
