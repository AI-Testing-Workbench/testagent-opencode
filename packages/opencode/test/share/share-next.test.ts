// testagent_change - tests updated to reflect share service removal
import { test, expect } from "bun:test"
import { ShareNext } from "../../src/share/share-next"

test("ShareNext.url returns empty string", async () => {
  const result = await ShareNext.url()
  expect(result).toBe("")
})

test("ShareNext.init is a no-op", async () => {
  await expect(ShareNext.init()).resolves.toBeUndefined()
})

test("ShareNext.create returns empty stub", async () => {
  const result = await ShareNext.create("session-1" as any)
  expect(result).toEqual({ id: "", url: "", secret: "" })
})
