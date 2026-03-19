import { Script, Command, VectrConfig } from './types'
import { VectrError, RollbackManager } from './error'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync, spawn } from 'child_process'

export class VectrRuntime {

  private variables: Map<string, string> = new Map()
  private cwd: string = process.cwd()
  private rollbackManager: RollbackManager
  private envVars: Record<string, string> = {}
  private secretValues: string[] = []

  constructor(private script: Script, private config: VectrConfig = {}) {

    this.rollbackManager = new RollbackManager(this.config?.enableSafeRuntime?.extras?.showLogs ?? true)
    this.initEnvAndSecrets()
  }

  private initEnvAndSecrets() {

    this.envVars = { ...process.env } as Record<string, string>

    for (const [key, value] of this.script.env.entries()) {
      this.envVars[key] = value
    }

    for (const [key, ref] of this.script.secrets.entries()) {
      let val = ''
      if (ref.type === 'env') {
        val = process.env[ref.name] || ''
      } else if (ref.type === 'file') {
        const p = path.resolve(this.cwd, ref.path)
        if (fs.existsSync(p)) {
          val = fs.readFileSync(p, 'utf-8').trim()
        } else {
          if (this.config?.enableSafeRuntime?.enabled) throw new VectrError(`Secret file not found: ${p}`)
        }
      }
      this.envVars[key] = val
      if (val) this.secretValues.push(val)
    }
  }

  private maskSecrets(text: string): string {

    let result = text

    for (const secret of this.secretValues) {

      if (!secret.trim()) continue

      result = result.split(secret).join('***')
    }

    return result
  }

  private interpolate(str: string): string {

    let result = str

    result = result.replace(/\$\{([a-zA-Z0-9_\.]+)\}/g, (match, key) => {
      if (this.variables.has(key)) return this.variables.get(key) as string
      if (this.envVars[key] !== undefined) return this.envVars[key]

      return match
    })

    result = result.replace(/\$([a-zA-Z0-9_\.]+)/g, (match, key) => {
      if (this.variables.has(key)) return this.variables.get(key) as string
      if (this.envVars[key] !== undefined) return this.envVars[key]

      return match
    })

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

        await this.executeStep(step)
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

  private async executeStep(step: import('./types').Step) {

    const name = step.name
    const startTime = Date.now()
    const showRunning = this.debugFlag('showRunning')
    const showOutput = this.debugFlag('showOutput')
    const showFinished = this.debugFlag('showFinished')
    const showTimes = this.debugFlag('showTimes')

    if (showRunning) {
      console.log(`\x1b[36m[Vectr]\x1b[0m Running step: \x1b[32m${name}\x1b[0m`)
    }

    const maxAttempts = (step.retry || 0) + 1
    const delayMs = step.delay || 0

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        for (const cmd of step.commands) {
          await this.executeCommand(cmd, name, showOutput)
        }
        break
      } catch (err: any) {
        if (attempt === maxAttempts) {
          if (step.onError) {
            if (showOutput) {
              console.log(`\x1b[33m[Vectr] Step ${name} failed. Running fallback wrapper...\x1b[0m`)
            }
            try {
              await this.executeCommand(step.onError, name, showOutput)
              break
            } catch (fallbackErr: any) {
              throw err
            }
          }
          throw err
        } else {
          if (showOutput) {
            console.log(`\x1b[33m[Vectr] Step ${name} failed (Attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs}ms...\x1b[0m`)
          }
          await new Promise(r => setTimeout(r, delayMs))
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

  private async executeCommand(cmd: Command, stepName: string, showOutput: boolean) {
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
          console.log(`\x1b[90m  ↳ var ${cmd.name} = '${this.maskSecrets(value)}'\x1b[0m`)
        }
        this.variables.set(cmd.name, value)
        this.variables.set(`${stepName}.${cmd.name}`, value)
        break
      }
      case 'capture': {
        const commandStr = this.interpolate(cmd.command)
        if (showOutput) {
          console.log(`\x1b[90m  ↳ var ${cmd.name} = capture ${this.maskSecrets(commandStr)}\x1b[0m`)
        }
        const showCommands = this.debugFlag('showCommands')

        await new Promise<void>((resolve, reject) => {
          const child = spawn(commandStr, {
            cwd: this.cwd,
            env: this.envVars,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
          })

          let capturedOutput = ''

          child.stdout.on('data', (data) => {
            capturedOutput += data.toString()
            if (showCommands) {
              process.stdout.write(this.maskSecrets(data.toString()))
            }
          })

          child.stderr.on('data', (data) => {
            if (showCommands) {
              process.stderr.write(this.maskSecrets(data.toString()))
            }
          })

          child.on('close', (code) => {
            if (code === 0) {
              const finalValue = capturedOutput.trim()
              this.variables.set(cmd.name, finalValue)
              this.variables.set(`${stepName}.${cmd.name}`, finalValue)
              resolve()
            } else {
              reject(new VectrError(`Command failed: ${this.maskSecrets(commandStr)}`))
            }
          })

          child.on('error', (err) => {
            reject(new VectrError(`Failed to start command: ${err.message}`))
          })
        })
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
          console.log(`\x1b[90m  ↳ ${this.maskSecrets(commandStr)}\x1b[0m`)
        }
        const showCommands = this.debugFlag('showCommands')

        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(commandStr, {
              cwd: this.cwd,
              env: this.envVars,
              shell: true,
              stdio: ['ignore', 'pipe', 'pipe']
            })

            child.stdout.on('data', (data) => {
              if (showCommands) {
                process.stdout.write(this.maskSecrets(data.toString()))
              }
            })

            child.stderr.on('data', (data) => {
              if (showCommands) {
                process.stderr.write(this.maskSecrets(data.toString()))
              }
            })

            child.on('close', (code) => {
              if (code === 0) {
                resolve()
              } else {
                reject(new VectrError(`Command failed: ${this.maskSecrets(commandStr)}`))
              }
            })

            child.on('error', (err) => {
              reject(new VectrError(`Failed to start command: ${err.message}`))
            })
          })
        } catch (err: any) {
          if (cmd.ignoreError) {
            if (showOutput) {
              console.log(`\x1b[33m[Vectr]\x1b[0m \x1b[90m↳ [Ignored Error] ${err.message}\x1b[0m`)
            }
          } else {
            throw err
          }
        }
        break
      }
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