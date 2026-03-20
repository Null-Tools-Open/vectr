import { Script, Command, VectrConfig } from './types'
import { VectrError, RollbackManager } from './error'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import fg from 'fast-glob'

interface ExecutionContext {
  cwd: string;
  variables: Map<string, string>;
  prefix: string;
  varPrefix: string;
  ignoreSafeRuntime?: boolean;
}

export class VectrRuntime {

  private variables: Map<string, string> = new Map()
  private cwd: string = process.cwd()
  private rollbackManager: RollbackManager
  private envVars: Record<string, string> = {}
  private secretValues: string[] = []
  private secretMaskRegex: RegExp | null = null

  constructor(private script: Script, private config: VectrConfig = {}) {

    this.rollbackManager = new RollbackManager(this.config?.enableSafeRuntime?.extras?.showLogs ?? true)

    if (this.config?.disableLeaveSafeguard) {
      console.warn('\x1b[33m[Vectr Warning] \x1b[1mLeave safeguards are disabled!\x1b[0m \x1b[33mCommands bypassing SafeRuntime will run without restrictions.\x1b[0m')
    }

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
        val = process.env[ref.name!] || ''
      } else if (ref.type === 'file') {
        const mockCtx: ExecutionContext = { cwd: this.cwd, variables: new Map(), prefix: '', varPrefix: '' }
        const p = this.resolvePath(ref.path!, mockCtx)
        if (fs.existsSync(p)) {
          val = fs.readFileSync(p, 'utf-8').trim()
        } else {
          if (this.config?.enableSafeRuntime?.enabled) throw new VectrError(`Secret file not found: ${p}`)
        }
      }
      this.envVars[key] = val
      if (val) this.secretValues.push(val)
    }

    if (this.secretValues.length > 0) {

      const escaped = this.secretValues
        .filter(s => s.trim())
        .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

      if (escaped.length > 0) {

        this.secretMaskRegex = new RegExp(escaped.join('|'), 'g')
      }
    }
  }

  private maskSecrets(text: string): string {
    if (!this.secretMaskRegex) return text
    return text.replace(this.secretMaskRegex, '***')
  }

  private interpolate(str: string, variables: Map<string, string>): string {

    return str.replace(/\$(?:\{([a-zA-Z0-9_\.-]+)\}|([a-zA-Z0-9_\.-]+))/g, (match, braced, bare) => {

      const key = braced || bare

      if (variables.has(key)) return variables.get(key) as string
      if (this.script.env.has(key)) return this.script.env.get(key) as string
      if (this.script.secrets.has(key)) return this.envVars[key]

      if (process.env[key] !== undefined) {
        throw new VectrError(`Environment variable '${key}' was accessed implicitly`)
      }

      return match
    })
  }

  private isDangerousCommand(cmd: Command): boolean {
    if (cmd.type === 'run') {
      const c = cmd.command.toLowerCase()
      if (/\brm\s+-r[f]?\s+\/($|\s|\*)/.test(c)) return true
      if (/\brm\s+-r[f]?\s+~\/($|\s|\*)/.test(c)) return true
      if (/\bmkfs\b/.test(c)) return true
      if (/>\s*\/dev\/sd[a-z]/.test(c)) return true
    }
    return false
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

      if (error.name === 'VectrError' || error.name === 'VectrSyntaxError') {
        console.error(`\n\x1b[41m\x1b[30m [Vectr] RUNTIME PANIC \x1b[0m`)
        console.error(`\x1b[31m${error.message}\x1b[0m\n`)
        process.exit(1)
      } else {
        throw error
      }
    }
  }

  private generateCombinations(matrix?: Map<string, string[]>): Record<string, string>[] {

    if (!matrix || matrix.size === 0) return [{}]

    const keys = Array.from(matrix.keys())
    const results: Record<string, string>[] = []

    const helper = (idx: number, current: Record<string, string>) => {

      if (idx === keys.length) {
        results.push({ ...current })
        return
      }

      const key = keys[idx]
      const values = matrix.get(key)!

      for (const val of values) {
        current[key] = val
        helper(idx + 1, current)
      }
    }
    helper(0, {})

    return results
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

    const combinations = this.generateCombinations(step.matrix)
    const maxAttempts = (step.retry || 0) + 1
    const delayMs = step.delay || 0

    const CONCURRENCY_LIMIT = 10

    for (let i = 0; i < combinations.length; i += CONCURRENCY_LIMIT) {
      const chunk = combinations.slice(i, i + CONCURRENCY_LIMIT)

      const executions = chunk.map(async (combo) => {
        const comboValues = Object.values(combo)
        const prefix = comboValues.length > 0 ? `[\x1b[35m${comboValues.join(',')}\x1b[0m] ` : ''

        const context: ExecutionContext = {
          cwd: this.cwd,
          variables: new Map(this.variables),
          prefix,
          varPrefix: step.name + (comboValues.length > 0 ? `_${comboValues.join('_')}` : '')
        }

        for (const [k, v] of Object.entries(combo)) {
          context.variables.set(k, v)
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            if (this.config?.dryRun) {
              if (step.dry) {
                if (showOutput) {
                  console.log(`\x1b[35m[Vectr] ${context.prefix}↳ [DRY] ${this.interpolate(step.dry, context.variables)}\x1b[0m`)
                }
                await this.executeCommand({ type: 'run', command: step.dry }, name, showOutput, context)
              } else {
                if (showOutput) {
                  console.log(`\x1b[35m[Vectr] ${context.prefix}Skipped step ${name} (dry-run)...\x1b[0m`)
                }
              }
              break
            }

            const executionPromises: Promise<any>[] = []

            executionPromises.push((async () => {
              for (const cmd of step.commands) {
                await this.executeCommand(cmd, name, showOutput, context)
              }
            })())

            if (step.shadows) {
              for (const [shadowName, targetCommands] of step.shadows.entries()) {
                const shadowContext: ExecutionContext = {
                  ...context,
                  prefix: `${context.prefix}[\x1b[36mshadow:${shadowName}\x1b[0m] `,
                  variables: new Map(context.variables)
                }
                executionPromises.push((async () => {
                  try {
                    for (const cmd of targetCommands) {
                      await this.executeCommand(cmd, name, showOutput, shadowContext)
                    }
                  } catch (e: any) {
                    if (showOutput) {
                      console.log(`\x1b[31m[Vectr] Shadow ${shadowName} failed: ${e.message}\x1b[0m`)
                    }
                  }
                })())
              }
            }

            await Promise.all(executionPromises)
            break
          } catch (err: any) {
            if (attempt === maxAttempts) {
              if (step.onError) {
                if (showOutput) {
                  console.log(`\x1b[33m[Vectr] ${context.prefix}Step ${name} failed. Running fallback wrapper...\x1b[0m`)
                }
                try {
                  await this.executeCommand(step.onError, name, showOutput, context)
                  break
                } catch (fallbackErr: any) {
                  throw err
                }
              }
              throw err
            } else {
              if (showOutput) {
                console.log(`\x1b[33m[Vectr] ${context.prefix}Step ${name} failed (Attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs}ms...\x1b[0m`)
              }
              await new Promise(r => setTimeout(r, delayMs))
            }
          }
        }
      })

      await Promise.all(executions)
    }

    const endTime = Date.now()
    const duration = endTime - startTime
    const timeStr = showTimes ? ` \x1b[90m(${duration}ms)\x1b[0m` : ''

    if (showFinished) {
      console.log(`\x1b[36m[Vectr]\x1b[0m Finished step: \x1b[32m${name}\x1b[0m${timeStr}`)
    }
  }

  private async executeCommand(cmd: Command, stepName: string, showOutput: boolean, ctx: ExecutionContext) {
    switch (cmd.type) {
      case 'print': {
        const msg = this.interpolate(cmd.message, ctx.variables)

        if (showOutput) {
          let color = '\x1b[36m'
          if (cmd.style === 'warn') color = '\x1b[33m'
          else if (cmd.style === 'ok') color = '\x1b[32m'
          else if (cmd.style === 'err') color = '\x1b[31m'

          console.log(`${color}[Vectr]\x1b[0m ${ctx.prefix}${msg}`)
        }
        break
      }
      case 'leave': {
        const leaveCtx = { ...ctx, ignoreSafeRuntime: true }
        for (const innerCmd of cmd.commands) {
          if (!this.config?.disableLeaveSafeguard && this.isDangerousCommand(innerCmd)) {
            if (cmd.onBlock) {
              if (typeof cmd.onBlock === 'string') {
                if (showOutput) console.log(`\x1b[31m[Vectr Blocked]\x1b[0m ${ctx.prefix}${cmd.onBlock}`)
              } else {
                for (const blockCmd of cmd.onBlock) {
                  await this.executeCommand(blockCmd, stepName, showOutput, ctx)
                }
              }
            } else {
              throw new VectrError(`Leave command blocked by safeguard. Dangerous code detected: ${(innerCmd as any).command}`)
            }
            continue
          }

          try {
            await this.executeCommand(innerCmd, stepName, showOutput, leaveCtx)
          } catch (e: any) {
            if (cmd.onError) {
              if (showOutput) console.log(`\x1b[33m[Vectr] ${ctx.prefix}Leave command failed. Running onError fallback...\x1b[0m`)
              for (const errCmd of cmd.onError) {
                await this.executeCommand(errCmd, stepName, showOutput, ctx)
              }
            } else {
              throw e
            }
          }
        }
        break
      }
      case 'cd': {
        const target = this.resolvePath(this.interpolate(cmd.path, ctx.variables), ctx)
        if (showOutput) {
          console.log(`\x1b[90m  ${ctx.prefix}↳ cd ${target}\x1b[0m`)
        }
        ctx.cwd = target
        break
      }
      case 'var': {
        const value = this.interpolate(cmd.value, ctx.variables)
        if (showOutput) {
          console.log(`\x1b[90m  ${ctx.prefix}↳ var ${cmd.name} = '${this.maskSecrets(value)}'\x1b[0m`)
        }
        ctx.variables.set(cmd.name, value)
        this.variables.set(`${ctx.varPrefix}.${cmd.name}`, value)
        break
      }
      case 'capture': {
        const commandStr = this.interpolate(cmd.command, ctx.variables)
        if (showOutput) {
          console.log(`\x1b[90m  ${ctx.prefix}↳ var ${cmd.name} = capture ${this.maskSecrets(commandStr)}\x1b[0m`)
        }
        const showCommands = this.debugFlag('showCommands')

        await new Promise<void>((resolve, reject) => {
          const child = spawn(commandStr, {
            cwd: ctx.cwd,
            env: this.envVars,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
          })

          const outputChunks: Buffer[] = []

          child.stdout.on('data', (data: Buffer) => {
            outputChunks.push(data)
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
              const finalValue = Buffer.concat(outputChunks).toString().trim()
              ctx.variables.set(cmd.name, finalValue)
              this.variables.set(`${ctx.varPrefix}.${cmd.name}`, finalValue)
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

        const src = this.resolvePath(this.interpolate(cmd.src, ctx.variables), ctx)
        const dest = this.resolvePath(this.interpolate(cmd.dest, ctx.variables), ctx)

        if (showOutput) {
          console.log(`\x1b[90m  ${ctx.prefix}↳ cp ${src} => ${dest}\x1b[0m`)
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
      case 'rm': {

        const p = this.interpolate(cmd.path, ctx.variables)
        const globs = p.includes('*') ? await fg(p, { cwd: ctx.cwd, dot: true, absolute: true }) : [this.resolvePath(p, ctx)]

        if (showOutput) {
          console.log(`\x1b[90m  ${ctx.prefix}↳ rm ${p}${cmd.ifExists ? ' (if exists)' : ''}\x1b[0m`)
        }

        for (const target of globs) {
          const resolved = this.resolvePath(target, ctx)
          if (!fs.existsSync(resolved)) {
            if (!cmd.ifExists) throw new VectrError(`Path does not exist to remove: ${resolved}`)
            continue
          }

          if (this.config?.useWorkers?.enabled) {
            await fs.promises.rm(resolved, { recursive: true, force: true })
          } else {
            fs.rmSync(resolved, { recursive: true, force: true })
          }
        }
        break
      }
      case 'mv': {
        const src = this.resolvePath(this.interpolate(cmd.src, ctx.variables), ctx)
        const dest = this.resolvePath(this.interpolate(cmd.dest, ctx.variables), ctx)

        if (showOutput) {
          console.log(`\x1b[90m  ${ctx.prefix}↳ mv ${src} => ${dest}\x1b[0m`)
        }

        if (!fs.existsSync(src)) {
          throw new VectrError(`Source path does not exist to move: ${src}`)
        }

        this.rollbackManager.add(() => {
          if (fs.existsSync(dest)) fs.renameSync(dest, src)
        })

        if (this.config?.useWorkers?.enabled) {
          await fs.promises.rename(src, dest)
        } else {
          fs.renameSync(src, dest)
        }
        break
      }
      case 'chmod': {
        const p = this.interpolate(cmd.path, ctx.variables)
        const mode = this.interpolate(cmd.mode, ctx.variables)

        const globs = p.includes('*') ? await fg(p, { cwd: ctx.cwd, dot: true, absolute: true }) : [this.resolvePath(p, ctx)]

        if (showOutput) {
          console.log(`\x1b[90m  ${ctx.prefix}↳ chmod ${p} ${mode}\x1b[0m`)
        }

        for (const target of globs) {
          const resolved = this.resolvePath(target, ctx)
          if (!fs.existsSync(resolved)) {
            throw new VectrError(`Path does not exist to chmod: ${resolved}`)
          }

          if (/^[0-7]{3,4}$/.test(mode)) {
            const numMode = parseInt(mode, 8)
            fs.chmodSync(resolved, numMode)
          } else {
            await new Promise<void>((resolve, reject) => {
              const child = spawn(`chmod ${mode} "${resolved}"`, { shell: true })
              child.on('close', code => code === 0 ? resolve() : reject(new VectrError(`chmod ${mode} failed on ${resolved}`)))
            })
          }
        }
        break
      }
      case 'run': {
        const commandStr = this.interpolate(cmd.command, ctx.variables)
        if (showOutput) {
          console.log(`\x1b[90m  ${ctx.prefix}↳ ${this.maskSecrets(commandStr)}\x1b[0m`)
        }
        const showCommands = this.debugFlag('showCommands')

        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(commandStr, {
              cwd: ctx.cwd,
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
              console.log(`\x1b[33m[Vectr]\x1b[0m \x1b[90m${ctx.prefix}↳ [Ignored Error] ${err.message}\x1b[0m`)
            }
          } else {
            throw err
          }
        }
        break
      }
    }
  }

  private resolvePath(p: string, ctx: ExecutionContext): string {

    if (p.startsWith('~/')) {
      p = path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2))
    }

    const resolved = path.resolve(ctx.cwd, p)

    if (this.config?.enableSafeRuntime?.enabled && !ctx.ignoreSafeRuntime) {

      const workspaceRoot = process.cwd()

      if (!resolved.startsWith(workspaceRoot)) {

        throw new VectrError(`Path traversal blocked by SafeRuntime: ${resolved}`)
      }
    }

    return resolved
  }
}