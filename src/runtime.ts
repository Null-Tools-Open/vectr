import { Script, Command, VectrConfig } from './types'
import { VectrError, RollbackManager } from './error'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'

export class VectrRuntime {

  private variables: Map<string, string> = new Map()
  private cwd: string = process.cwd()
  private rollbackManager: RollbackManager

  constructor(private script: Script, private config: VectrConfig = {}) {

    this.rollbackManager = new RollbackManager(this.config?.enableSafeRuntime?.extras?.showLogs ?? true)
  }

  private interpolate(str: string): string {

    let result = str

    for (const [key, value] of this.variables.entries()) {

      const regex = new RegExp(`\\b${key}\\b`, 'g')

      result = result.replace(regex, value)
    }

    return result
  }

  private debugFlag(name: keyof NonNullable<NonNullable<VectrConfig['showDebug']>['extra']>): boolean {

    const extra = this.config?.showDebug?.extra

    if (extra && extra[name] !== undefined) {

      return extra[name] as boolean
    }

    return this.config?.showDebug?.enabled ?? false
  }

  private get snapDir() {
    const folderHash = Buffer.from(process.cwd()).toString('base64').replace(/[^a-zA-Z0-9]/g, '')
    return path.join(os.tmpdir(), `.vectr_snap_${folderHash}`)
  }

  private async takeSnapshot() {

    const snap = this.snapDir

    if (fs.existsSync(snap)) {
      await fs.promises.rm(snap, { recursive: true, force: true })
    }

    const filter = (src: string, dest: string) => {
      const basename = path.basename(src)
      return basename !== 'node_modules' && basename !== '.git' && basename !== '.vectr_cache_snap'
    }

    await fs.promises.cp(process.cwd(), snap, { recursive: true, filter })
  }

  private async restoreSnapshot() {

    const snap = this.snapDir

    if (!fs.existsSync(snap)) return

    try {

      const files = await fs.promises.readdir(process.cwd())

      for (const file of files) {

        if (file === 'node_modules' || file === '.git' || file === '.vectr_cache_snap') continue

        await fs.promises.rm(path.join(process.cwd(), file), { recursive: true, force: true })
      }

      await fs.promises.cp(snap, process.cwd(), { recursive: true })

      console.log(`\x1b[32m[Vectr] Snapshot restored perfectly.\x1b[0m`)

    } catch (err: any) {
      console.warn(`\x1b[31m[Vectr]\x1b[0m Warning: Snapshot restoration encountered an issue: ${err.message}`)
    }
  }

  private async cleanupSnapshot() {

    const snap = this.snapDir

    if (fs.existsSync(snap)) {

      await fs.promises.rm(snap, { recursive: true, force: true })
    }
  }

  public async run() {

    const globalStartTime = Date.now()
    const useSnapshot = this.config?.useWorkers?.enabled &&
      this.config?.enableSafeRuntime?.extras?.revertOnFailure

    try {

      if (useSnapshot) {

        await this.takeSnapshot()
      }

      for (const stepName of this.script.flow) {

        const step = this.script.steps.get(stepName)

        if (!step) {

          throw new VectrError(`Step not found: ${stepName}`)
        }

        await this.executeStep(stepName, step.commands)
      }

      if (this.debugFlag('showFinalStats')) {

        const globalEndTime = Date.now()
        const totalTime = globalEndTime - globalStartTime

        console.log(`\n\x1b[32m[Vectr] Script finished!\x1b[0m \x1b[90m(Total time: ${totalTime}ms)\x1b[0m`)
      }

      if (useSnapshot) {

        await this.cleanupSnapshot()
      }

    } catch (error: any) {

      if (this.config?.enableSafeRuntime?.extras?.revertOnFailure) {

        if (useSnapshot) {
          await this.restoreSnapshot()
          await this.cleanupSnapshot()

        } else {

          this.rollbackManager.rollback()
        }
      }

      throw error
    }
  }

  private async executeStep(name: string, commands: Command[]) {

    const startTime = Date.now()
    const showRunning = this.debugFlag('showRunning')
    const showOutput = this.debugFlag('showOutput')
    const showFinished = this.debugFlag('showFinished')
    const showTimes = this.debugFlag('showTimes')

    if (showRunning) {
      console.log(`\x1b[36m[Vectr]\x1b[0m Running step: \x1b[32m${name}\x1b[0m`)
    }

    for (const cmd of commands) {
      switch (cmd.type) {
        case 'cd': {
          const target = this.resolvePath(this.interpolate(cmd.path))
          if (showOutput) {
            console.log(`\x1b[90m  ↳ cd ${target}\x1b[0m`)
          }
          this.cwd = target
          break
        }
        case 'var': {
          const value = this.interpolate(cmd.value)
          if (showOutput) {
            console.log(`\x1b[90m  ↳ var ${cmd.name} = '${value}'\x1b[0m`)
          }
          this.variables.set(cmd.name, value)
          break
        }
        case 'cp': {
          const src = this.resolvePath(this.interpolate(cmd.src))
          const dest = this.resolvePath(this.interpolate(cmd.dest))

          if (showOutput) {
            console.log(`\x1b[90m  ↳ cp ${src} => ${dest}\x1b[0m`)
          }

          if (!fs.existsSync(src)) {
            const msg = `Source path does not exist ${src}`
            if (this.config?.enableSafeRuntime?.enabled) {
              throw new VectrError(msg)
            } else {
              console.warn(`\x1b[33m[Vectr]\x1b[0m Warning: ${msg}`)
              break
            }
          }

          this.rollbackManager.registerCp(dest)

          if (this.config?.useWorkers?.enabled) {
            await fs.promises.cp(src, dest, { recursive: true })
          } else {
            fs.cpSync(src, dest, { recursive: true })
          }
          break
        }
        case 'run': {
          const commandStr = this.interpolate(cmd.command)
          if (showOutput) {
            console.log(`\x1b[90m  ↳ ${commandStr}\x1b[0m`)
          }
          const showCommands = this.debugFlag('showCommands')
          try {
            execSync(commandStr, {
              cwd: this.cwd,
              stdio: showCommands ? 'inherit' : 'ignore'
            })
          } catch (err: any) {
            console.error(`\x1b[31m[Vectr]\x1b[0m Command failed with exit code ${err.status}`)
            if (this.config?.enableSafeRuntime?.enabled) {
              throw new VectrError(`Command failed: ${commandStr}`)
            } else {
              process.exit(1)
            }
          }
          break
        }
      }
    }

    const endTime = Date.now()
    const duration = endTime - startTime
    const timeStr = showTimes ? ` \x1b[90m(${duration}ms)\x1b[0m` : ''

    if (showFinished) {
      console.log(`\x1b[36m[Vectr]\x1b[0m Finished step: \x1b[32m${name}\x1b[0m${timeStr}`)
    }
  }

  private resolvePath(p: string): string {

    if (p.startsWith('~/')) {
      p = path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2))
    }

    const resolved = path.resolve(this.cwd, p)

    if (this.config?.enableSafeRuntime?.enabled) {

      const workspaceRoot = process.cwd()

      if (!resolved.startsWith(workspaceRoot)) {

        throw new VectrError(`Path traversal blocked by SafeRuntime: ${resolved}`)
      }
    }

    return resolved
  }
}