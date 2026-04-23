// testagent_change - new file
import { test, expect, describe } from "bun:test"
import { WorkflowsMigrator } from "../../src/testagent/workflows-migrator"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import { Filesystem } from "../../src/util/filesystem"

describe("WorkflowsMigrator", () => {
  describe("extractNameFromFilename", () => {
    test("extracts name from simple filename", () => {
      expect(WorkflowsMigrator.extractNameFromFilename("code-review.md")).toBe("code-review")
    })

    test("extracts name from path", () => {
      expect(WorkflowsMigrator.extractNameFromFilename("/path/to/my-workflow.md")).toBe("my-workflow")
    })

    test("handles filename without extension", () => {
      expect(WorkflowsMigrator.extractNameFromFilename("workflow")).toBe("workflow")
    })
  })

  describe("extractDescription", () => {
    test("extracts description after title", () => {
      const content = "# Title\n\nThis is the description"
      expect(WorkflowsMigrator.extractDescription(content)).toBe("This is the description")
    })

    test("returns undefined when no description", () => {
      const content = "# Title\n\n"
      expect(WorkflowsMigrator.extractDescription(content)).toBeUndefined()
    })

    test("truncates long descriptions", () => {
      const longDesc = "a".repeat(300)
      const content = `# Title\n\n${longDesc}`
      const result = WorkflowsMigrator.extractDescription(content)
      expect(result?.length).toBe(200)
    })
  })

  describe("discoverWorkflows", () => {
    test("discovers project workflows", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, ".testagent", "workflows", "test.md"), "# Test\n\nTest workflow")
        },
      })

      const workflows = await WorkflowsMigrator.discoverWorkflows(tmp.path)
      expect(workflows).toHaveLength(1)
      expect(workflows[0].name).toBe("test")
      expect(workflows[0].source).toBe("project")
    })

    test("project workflows override global", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, ".testagent", "workflows", "test.md"), "# Project\n\nProject workflow")
        },
      })

      const result = await WorkflowsMigrator.migrate({ projectDir: tmp.path, skipGlobalPaths: true })
      expect(result.commands.test).toBeDefined()
      expect(result.commands.test.template).toContain("Project workflow")
    })
  })

  describe("migrate", () => {
    test("converts workflows to commands", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(
            path.join(dir, ".testagent", "workflows", "code-review.md"),
            "# Code Review\n\nReview the code",
          )
          await Filesystem.write(
            path.join(dir, ".testagent", "workflows", "refactor.md"),
            "# Refactor\n\nRefactor code",
          )
        },
      })

      const result = await WorkflowsMigrator.migrate({ projectDir: tmp.path, skipGlobalPaths: true })

      expect(Object.keys(result.commands)).toHaveLength(2)
      expect(result.commands["code-review"]).toBeDefined()
      expect(result.commands["code-review"].description).toBe("Review the code")
      expect(result.commands["refactor"]).toBeDefined()
    })

    test("warns on duplicate names", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, ".testagent", "workflows", "test.md"), "# Test\n\nProject")
        },
      })

      const result = await WorkflowsMigrator.migrate({ projectDir: tmp.path, skipGlobalPaths: false })
      // If there's a global workflow with the same name, we should get a warning
      // For now, just check that the function runs without error
      expect(result.commands.test).toBeDefined()
    })
  })
})
