import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PKG } from './ops-helpers'

/** Every shell script under scripts/ passes shellcheck at warning level. Skipped where shellcheck is not installed. */
const have = spawnSync('shellcheck', ['--version']).status === 0

function shellScripts(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return shellScripts(p)
    return e.name.endsWith('.sh') ? [p] : []
  })
}

describe('shellcheck', () => {
  it.skipIf(!have)('is clean on every script in scripts/', () => {
    const files = shellScripts(path.join(PKG, 'scripts'))
    expect(files.length).toBeGreaterThan(5)
    const r = spawnSync('shellcheck', ['-x', '-P', 'SCRIPTDIR', '--severity=warning', ...files], { cwd: PKG, encoding: 'utf8' })
    expect(r.stdout + r.stderr, 'shellcheck findings').toBe('')
    expect(r.status).toBe(0)
  })

  it('every script is bash 3.2 friendly: no associative arrays, mapfile or case conversion', () => {
    for (const file of shellScripts(path.join(PKG, 'scripts'))) {
      const text = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
      expect(text, file).not.toMatch(/declare -A|\bmapfile\b|\breadarray\b|\$\{[A-Za-z_]+(,,|\^\^)\}/)
    }
  })
})
