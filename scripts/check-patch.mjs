#!/usr/bin/env node
// Validate a profile's cordis.patch.yml with the host's own parser.
//
// This exists because a single missing newline in the patch (a `- { … }` entry
// glued to the next key) makes DSH fail at startup with
//   DesktopHostFatalError: failed to parse overlay … YAMLException
// and the desktop app offers to "disable third-party plugins", which strips
// every bundle. Catching it here costs two seconds.
//
// The check is authoritative rather than re-implemented: it copies the profile
// into a throw-away sibling profile and runs `dsh --dump-config`, so the real
// loader parses the real overlay with the real merge rules.
//
// Usage:
//   node scripts/check-patch.mjs                      # profile "desktop", $DSH_HOME
//   node scripts/check-patch.mjs --profile web
//   node scripts/check-patch.mjs --home E:\dsh --profile desktop
//   node scripts/check-patch.mjs --file path\to\cordis.patch.yml   # syntax only
//
// Exit code 0 = the host parsed and composed the profile; 1 = it would not boot.
import { execFileSync } from 'node:child_process'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function parseArgs(argv) {
  const out = { profile: 'desktop', home: undefined, file: undefined, keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--home') out.home = argv[++i]
    else if (arg === '--file') out.file = argv[++i]
    else if (arg === '--keep') out.keep = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

/** Cheap structural checks that catch the mistakes people actually make. */
function staticChecks(text) {
  const problems = []
  if (text.trim() === '') {
    problems.push('the file is empty (an empty overlay must still be `[]`)')
    return problems
  }
  if (text.includes('\t')) problems.push('contains a TAB character; YAML forbids tabs for indentation')
  if (text.charCodeAt(0) === 0xfeff) problems.push('starts with a UTF-8 BOM; write it without one')

  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    // A `}` followed by more content on the same line is the classic
    // "missing newline between a flow mapping and the next key" breakage.
    if (/}[ \t]+[A-Za-z_][\w-]*:/.test(line)) {
      problems.push(`line ${index + 1}: a flow mapping is glued to the next key — missing newline`)
    }
  })
  return problems
}

/** Windows needs a junction for node_modules; POSIX can use a symlink. */
function linkModules(target, linkPath) {
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'pipe' })
  } else {
    execFileSync('ln', ['-s', target, linkPath], { stdio: 'pipe' })
  }
}

function unlinkModules(linkPath) {
  if (!existsSync(linkPath)) return
  const stat = lstatSync(linkPath)
  if (process.platform === 'win32' && stat.isSymbolicLink()) {
    execFileSync('cmd', ['/c', 'rmdir', linkPath], { stdio: 'pipe' })
  } else if (stat.isSymbolicLink()) {
    unlinkSync(linkPath)
  } else {
    rmSync(linkPath, { recursive: true, force: true })
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n').replace(/^\/\/ ?/gm, ''))
    return 0
  }

  const home = args.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')

  if (args.file !== undefined) {
    const patchPath = resolve(args.file)
    if (!existsSync(patchPath)) {
      console.error(`FAIL  ${patchPath} does not exist`)
      return 1
    }
    const problems = staticChecks(readFileSync(patchPath, 'utf8'))
    if (problems.length > 0) {
      console.error(`FAIL  ${patchPath}`)
      for (const problem of problems) console.error(`  - ${problem}`)
      return 1
    }
    console.log(`PASS  ${patchPath} (static checks only; run without --file to compose the profile)`)
    return 0
  }

  const profileDir = join(home, 'profiles', args.profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    console.error(`FAIL  no profile patch at ${patchPath}`)
    return 1
  }

  const problems = staticChecks(readFileSync(patchPath, 'utf8'))
  if (problems.length > 0) {
    console.error(`FAIL  static checks on ${patchPath}`)
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }

  const scratchName = `${args.profile}-check-${process.pid}`
  const scratchDir = join(home, 'profiles', scratchName)
  const modulesLink = join(scratchDir, 'node_modules')
  const realModules = join(profileDir, 'node_modules')

  const cleanup = () => {
    if (args.keep) {
      console.log(`kept ${scratchDir}`)
      return
    }
    try { unlinkModules(modulesLink) } catch { /* already gone */ }
    try { rmSync(scratchDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  try {
    mkdirSync(scratchDir, { recursive: true })
    for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
      const from = join(profileDir, name)
      if (existsSync(from)) copyFileSync(from, join(scratchDir, name))
    }
    if (existsSync(realModules)) linkModules(realModules, modulesLink)

    let output = ''
    let ok = true
    try {
      // `dsh` is a .cmd shim on Windows, which execFileSync cannot spawn
      // directly: go through cmd /c there.
      const command = process.platform === 'win32' ? 'cmd' : 'dsh'
      const argv = process.platform === 'win32'
        ? ['/c', 'dsh', '--profile', scratchName, '--dump-config']
        : ['--profile', scratchName, '--dump-config']
      output = execFileSync(command, argv, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME: home },
        timeout: 180_000,
      })
    } catch (error) {
      ok = false
      output = `${error.stdout ?? ''}${error.stderr ?? ''}` || String(error.message ?? error)
    }

    if (!ok) {
      console.error(`FAIL  the host cannot compose profile "${args.profile}"`)
      const detail = output.split('\n').filter((line) => line.trim() !== '').slice(-25).join('\n')
      console.error(detail)
      return 1
    }

    const entries = (output.match(/^- id: /gm) ?? []).length
    console.log(`PASS  profile "${args.profile}" composes (${entries} top-level entries)`)
    console.log(`      ${patchPath}`)
    return 0
  } finally {
    cleanup()
  }
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`FAIL  ${error?.message ?? error}`)
  process.exitCode = 1
}
