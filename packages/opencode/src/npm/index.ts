import semver from "semver"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import { readdir, rm } from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@/util/flock"
import { Arborist } from "@npmcli/arborist"

export namespace Npm {
  const log = Log.create({ service: "npm" })
  const illegal = process.platform === "win32" ? new Set(["<", ">", ":", '"', "|", "?", "*"]) : undefined

  export const InstallFailedError = NamedError.create(
    "NpmInstallFailedError",
    z.object({
      pkg: z.string(),
    }),
  )

  export function sanitize(pkg: string) {
    if (!illegal) return pkg
    return Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
  }

  function directory(pkg: string) {
    return path.join(Global.Path.cache, "packages", sanitize(pkg))
  }

  function resolveEntryPoint(name: string, dir: string) {
    let entrypoint: string | undefined
    try {
      entrypoint = typeof Bun !== "undefined" ? import.meta.resolve(name, dir) : import.meta.resolve(dir)
    } catch {}
    const result = {
      directory: dir,
      entrypoint,
    }
    return result
  }

  export async function outdated(pkg: string, cachedVersion: string): Promise<boolean> {
    // testagent_change: use internal npm registry
    const registry = process.env.NPM_REGISTRY || "http://central.jaf.cmbchina.cn:80/artifactory/api/npm/group-npm"
    const response = await fetch(`${registry}/${pkg}`)
    if (!response.ok) {
      log.warn("Failed to resolve latest version, using cached", { pkg, cachedVersion })
      return false
    }

    const data = (await response.json()) as { "dist-tags"?: { latest?: string } }
    const latestVersion = data?.["dist-tags"]?.latest
    if (!latestVersion) {
      log.warn("No latest version found, using cached", { pkg, cachedVersion })
      return false
    }

    const range = /[\s^~*xX<>|=]/.test(cachedVersion)
    if (range) return !semver.satisfies(latestVersion, cachedVersion)

    return semver.lt(cachedVersion, latestVersion)
  }

  export async function add(pkg: string) {
    const dir = directory(pkg)
    await using _ = await Flock.acquire(`npm-install:${Filesystem.resolve(dir)}`)
    log.info("installing package", {
      pkg,
    })

    // testagent_change: configure internal npm registry
    const registry = process.env.NPM_REGISTRY || "http://central.jaf.cmbchina.cn:80/artifactory/api/npm/group-npm"
    const arborist = new Arborist({
      path: dir,
      binLinks: true,
      progress: false,
      savePrefix: "",
      ignoreScripts: true,
      registry,
    })
    const tree = await arborist.loadVirtual().catch(() => {})
    if (tree) {
      const first = tree.edgesOut.values().next().value?.to
      if (first) {
        return resolveEntryPoint(first.name, first.path)
      }
    }

    const result = await arborist
      .reify({
        add: [pkg],
        save: true,
        saveType: "prod",
      })
      .catch((cause) => {
        throw new InstallFailedError(
          { pkg },
          {
            cause,
          },
        )
      })

    const first = result.edgesOut.values().next().value?.to
    if (!first) throw new InstallFailedError({ pkg })
    return resolveEntryPoint(first.name, first.path)
  }

  export async function install(dir: string) {
    await using _ = await Flock.acquire(`npm-install:${dir}`)
    log.info("checking dependencies", { dir })

    const reify = async () => {
      // testagent_change: configure internal npm registry
      const registry = process.env.NPM_REGISTRY || "http://central.jaf.cmbchina.cn:80/artifactory/api/npm/group-npm"
      const arb = new Arborist({
        path: dir,
        binLinks: true,
        progress: false,
        savePrefix: "",
        ignoreScripts: true,
        registry,
      })
      await arb.reify().catch((err) => {
        // testagent_change - log error instead of silently swallowing it
        log.error("failed to install dependencies", { dir, error: err })
        throw err
      })
    }

    if (!(await Filesystem.exists(path.join(dir, "node_modules")))) {
      log.info("node_modules missing, reifying")
      await reify()
      return
    }

    const pkg = await Filesystem.readJson(path.join(dir, "package.json")).catch(() => ({}))
    const lock = await Filesystem.readJson(path.join(dir, "package-lock.json")).catch(() => ({}))

    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ])

    const root = lock.packages?.[""] || {}
    const locked = new Set([
      ...Object.keys(root.dependencies || {}),
      ...Object.keys(root.devDependencies || {}),
      ...Object.keys(root.peerDependencies || {}),
      ...Object.keys(root.optionalDependencies || {}),
    ])

    for (const name of declared) {
      if (!locked.has(name)) {
        log.info("dependency not in lock file, reifying", { name })
        await reify()
        return
      }
      // testagent_change start - also check if package actually exists in node_modules
      const pkgPath = path.join(dir, "node_modules", name)
      if (!(await Filesystem.exists(pkgPath))) {
        log.info("dependency missing in node_modules, reifying", { name })
        await reify()
        return
      }
      // testagent_change end
    }

    log.info("dependencies in sync")
  }

  export async function which(pkg: string) {
    const dir = directory(pkg)
    const binDir = path.join(dir, "node_modules", ".bin")

    const pick = async () => {
      const files = await readdir(binDir).catch(() => [])
      if (files.length === 0) return undefined
      if (files.length === 1) return files[0]
      // Multiple binaries — resolve from package.json bin field like npx does
      const pkgJson = await Filesystem.readJson<{ bin?: string | Record<string, string> }>(
        path.join(dir, "node_modules", pkg, "package.json"),
      ).catch(() => undefined)
      if (pkgJson?.bin) {
        const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
        const bin = pkgJson.bin
        if (typeof bin === "string") return unscoped
        const keys = Object.keys(bin)
        if (keys.length === 1) return keys[0]
        return bin[unscoped] ? unscoped : keys[0]
      }
      return files[0]
    }

    const bin = await pick()
    if (bin) return path.join(binDir, bin)

    await rm(path.join(dir, "package-lock.json"), { force: true })
    await add(pkg)
    const resolved = await pick()
    if (!resolved) return
    return path.join(binDir, resolved)
  }
}
