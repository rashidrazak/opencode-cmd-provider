// tests/plugin-install.test.ts — verifies zero-step delivery:
// `opencode plugin add <pkg>` detects server + tui targets from
// package.json exports["./tui"] and writes both opencode.json(c) and tui.json
// with the same spec. Uses a local file:// spec so it runs without network
// and without publishing.
import { spawnSync } from "node:child_process"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { run, assert, assertEqual } from "./harness.js"

const hasOpenCode = spawnSync("which", ["opencode"]).status === 0

run([
  [
    "opencode plugin add file://<pkg> creates both opencode.json and tui.json with same spec",
    () => {
      if (!hasOpenCode) {
        console.log("skip - opencode not on PATH")
        return
      }
      const home = mkdtempSync(join(tmpdir(), "oc-install-home-"))
      const proj = mkdtempSync(join(tmpdir(), "oc-install-proj-"))
      const isoEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".data"),
        XDG_CACHE_HOME: join(home, ".cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      }
      const pkgPath = resolve(import.meta.dirname, "..")
      const spec = `file://${pkgPath}`

      const result = spawnSync("opencode", ["plugin", spec], {
        cwd: proj,
        env: isoEnv,
        encoding: "utf-8",
        timeout: 30_000,
      })
      assertEqual(result.status, 0, `opencode plugin add failed: ${result.stderr || result.stdout}`)

      // Installer writes to <proj>/.opencode/* when inside a project dir
      const serverPath = join(proj, ".opencode", "opencode.json")
      const tuiPath = join(proj, ".opencode", "tui.json")
      assert(existsSync(serverPath), `missing ${serverPath}`)
      assert(
        existsSync(tuiPath),
        `missing ${tuiPath} — server+tui targets not detected from exports["./tui"]`,
      )

      const server = JSON.parse(readFileSync(serverPath, "utf-8")) as { plugin?: string[] }
      const tui = JSON.parse(readFileSync(tuiPath, "utf-8")) as { plugin?: string[] }
      assert(Array.isArray(server.plugin), "opencode.json plugin must be an array")
      assert(Array.isArray(tui.plugin), "tui.json plugin must be an array")
      assertEqual(server.plugin, tui.plugin, "both configs must carry the same spec")
      assert(server.plugin[0] === spec, `expected spec ${spec}, got ${server.plugin[0]}`)

      // Global HOME stays at empty opencode.jsonc (project-local install)
      // and no stray tui.json in global config
      const globalTui = join(home, ".config", "opencode", "tui.json")
      assert(
        !existsSync(globalTui),
        "global tui.json must not be created for project-local install",
      )
    },
  ],
  [
    "published artifact would contain both server and tui (npm pack dry-run)",
    () => {
      // Validate via npm pack --dry-run that dist/tui.js is included
      const packed = spawnSync("npm", ["pack", "--dry-run"], {
        encoding: "utf-8",
        timeout: 15_000,
      })
      const out = (packed.stdout || "") + (packed.stderr || "")
      assert(out.includes("dist/tui.js"), "npm pack must include dist/tui.js")
      assert(out.includes("dist/index.js"), "npm pack must include dist/index.js")
    },
  ],
  [
    "bare opencode TUI sidebar renders Deals intelligence without manual tui.json (zero-step)",
    async () => {
      // Server plugin enriches the selected model with options.cmd via snapshot+deals;
      // TUI plugin's dealsRows then renders Tier/allowance etc. without any hand-written tui.json.
      const { MODEL_SNAPSHOT } = await import("../src/catalog/snapshot.js")
      const { autoRegister } = await import("../src/plugin/models.js")
      const { enrichCommandCodeModels } = await import("../src/deals/index.js")
      const { dealsRows } = await import("../src/deals/tui.js")
      // Simulate the config hook's auto-registration + enrichment pipeline
      const config: any = {}
      autoRegister(config, MODEL_SNAPSHOT, {
        npm: "opencode-cmd-provider",
        name: "Command Code",
        baseURL: "http://test",
      })
      enrichCommandCodeModels(config)
      // Pick a model known to have deals data (claude-sonnet-5 has premium tier + pro allowance)
      const model = config.provider?.commandcode?.models?.["claude-sonnet-5"]
      assert(model, "enriched config must contain claude-sonnet-5")
      assert(model.options?.cmd, "model.options.cmd must be injected by enrichment")
      const rows = dealsRows(model)
      assert(rows.length > 0, "dealsRows must return visible rows without manual tui.json")
      const labels = rows.map(([k]) => k)
      assert(labels.includes("Tier"), "dealsRows must include Tier when TUI is auto-delivered")
      // When catalog is unavailable the banner still makes the panel visible
      const emptyRows = dealsRows({ options: { cmd: { unavailable: true } } } as any)
      assert(
        emptyRows.some(([k]) => k.startsWith("Deals unavailable")),
        "unavailable banner must keep panel visible",
      )
    },
  ],
])
