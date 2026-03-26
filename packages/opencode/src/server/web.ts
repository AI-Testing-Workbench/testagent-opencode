// testagent_change - new file
import mime from "mime-types"

// APP_MANIFEST is injected at build time by build.ts via Bun.build define.
// It maps blob.name (filename only) -> URL path (e.g. "index-abc.js" -> "/assets/index-abc.js").
// At dev time (no embedded files) this is undefined and all functions return undefined.
declare const APP_MANIFEST: Record<string, string> | undefined

// Build URL path -> Blob map from Bun.embeddedFiles using the injected manifest.
const assets = (() => {
  if (typeof APP_MANIFEST === "undefined" || !Bun.embeddedFiles.length) return new Map<string, Blob>()
  const map = new Map<string, Blob>()
  for (const blob of Bun.embeddedFiles as (Blob & { name: string })[]) {
    const url = APP_MANIFEST[blob.name]
    if (!url) continue
    map.set(url, blob)
  }
  return map
})()

export function serveAsset(url: string): Response | undefined {
  const blob = assets.get(url)
  if (!blob) return undefined
  return new Response(blob, { headers: { "content-type": mime.lookup(url) || "application/octet-stream" } })
}

export function serveIndex(): Response | undefined {
  const blob = assets.get("/index.html")
  if (!blob) return undefined
  return new Response(blob, { headers: { "content-type": "text/html; charset=utf-8" } })
}
