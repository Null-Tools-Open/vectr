import { Script, Step, Command, SecretReference, VectrConfig } from './types'
import { VectrRuntime } from './runtime'

export class StepBuilder {

  constructor(private step: Step) { }

  /**
   * Executes a shell command inside the current directory
   * @param command The shell command to execute
   * @param ignoreError If true, the step won't trigger a rollback even if the command exits with a non-zero code
  */
  run(command: string, ignoreError?: boolean): this {
    this.step.commands.push({ type: 'run', command, ignoreError })

    return this
  }

  /**
   * Changes the current working directory for subsequent commands within this step
   * Automatically supervised by SafeRuntime to prevent path traversal
   * @param path The path to navigate to. Can be relative or absolute
  */
  cd(path: string): this {
    this.step.commands.push({ type: 'cd', path })

    return this
  }

  /**
   * Copies a file or directory recursively
   * Leverages asynchronous non-blocking I/O natively if `useWorkers` is enabled
   * @param src Source path
   * @param dest Destination path
  */
  cp(src: string, dest: string): this {
    this.step.commands.push({ type: 'cp', src, dest })

    return this
  }

  /**
   * Declares a local variable within the step.
   * It can be referenced later in any command via `${name}` or `$name`
   * @param name Custom name of the variable
   * @param value String value to assign to the variable
  */
  var(name: string, value: string): this {
    this.step.commands.push({ type: 'var', name, value })

    return this
  }

  /**
   * Executes a command and natively captures its standard output into a variable
   * @param name Name of the local variable that will hold the terminal output
   * @param command The shell command to execute and monitor
  */
  capture(name: string, command: string): this {
    this.step.commands.push({ type: 'capture', name, command })

    return this
  }

  /**
   * Prints a message cleanly to the execution console
   * @param message The message to print. Supports variable interpolation
  */
  print(message: string): this {
    this.step.commands.push({ type: 'print', message })

    return this
  }

  /**
   * Prints a yellow warning message cleanly to the execution console
   * @param message The message to print
  */
  warn(message: string): this {
    this.step.commands.push({ type: 'print', style: 'warn', message })
    return this
  }

  /**
   * Prints a green success message cleanly to the execution console
   * @param message The message to print
  */
  ok(message: string): this {
    this.step.commands.push({ type: 'print', style: 'ok', message })
    return this
  }

  /**
   * Prints a red error message cleanly to the execution console
   * @param message The message to print
  */
  err(message: string): this {
    this.step.commands.push({ type: 'print', style: 'err', message })
    return this
  }

  /**
   * Removes paths natively supporting wildcards/globs
   * @param path The path or glob to remove
   * @param ifExists If true, suppresses errors when the path doesn't exist
  */
  rm(path: string, ifExists?: boolean): this {
    this.step.commands.push({ type: 'rm', path, ifExists })
    return this
  }

  /**
   * Moves or renames a file/directory natively
   * @param src Source path
   * @param dest Destination path
  */
  mv(src: string, dest: string): this {
    this.step.commands.push({ type: 'mv', src, dest })
    return this
  }

  /**
   * Changes permissions of a file. Supports globs
   * @param path Path or glob to chmod
   * @param mode Permission mode or numerical identifier (e.g. `+x` or `0755`)
  */
  chmod(path: string, mode: string): this {
    this.step.commands.push({ type: 'chmod', path, mode })
    return this
  }

  /**
   * Intentionally bypasses the SafeRuntime protections for specific commands
   * Useful for performing global installations (e.g. `npm install -g`), or writes targeting `/tmp`
   * @param commands The commands to execute outside the sandbox
   * @param onBlock Command(s) or string to execute/print if SafeRuntime statically blocks this action
   * @param onError Command(s) to execute if one of the sandbox-busting commands fails
  */
  leave(
    commands: Command[],
    onBlock?: string | Command[],
    onError?: Command[]
  ): this {
    this.step.commands.push({ type: 'leave', commands, onBlock, onError })

    return this
  }

  /**
   * Runs this entire step multiple times, scaling across concurrent combinations of the given matrix
   * Execution respects the max parallelism limits of the runtime environment
   * @param matrix A key-value object where keys are variable names, and values are arrays of strings
   * Example: `{ os: ['linux', 'windows'], node: ['18', '20'] }`
  */
  matrix(matrix: Record<string, string[]>): this {
    this.step.matrix = new Map(Object.entries(matrix))

    return this
  }

  /**
   * Makes the core runtime automatically retry the entire step if it fails during execution
   * Helpful for downloading over unstable networks or querying flaky APIs
   * @param count The max number of extra attempts
   * @param delayMs Delay in milliseconds between attempts
  */
  retry(count: number, delayMs: number = 0): this {
    this.step.retry = count
    this.step.delay = delayMs

    return this
  }

  /**
   * Provides a fallback action to execute if the step permanently fails
   * (even after all permitted retries are completely exhausted)
   * @param command The fallback sequence to trigger
  */
  onError(command: Command): this {
    this.step.onError = command

    return this
  }

  /**
   * Injects a replacement sequence that will be used purely during dry-runs, ignoring actual logic
   * @param command The mock command to run instead of the real sequence
  */
  dry(command: string): this {
    this.step.dry = command

    return this
  }

  /**
   * Isolates a group of commands into an independent, non-fatal "shadow" sandbox
   * Hard errors crashing inside a shadow step are logged but do NOT crash the parent step
   * @param name Name of the isolated context
   * @param buildFn Closure defining the shadow commands
  */
  shadow(name: string, buildFn: (builder: StepBuilder) => void): this {

    if (!this.step.shadows) {
      this.step.shadows = new Map<string, Command[]>()
    }

    const shadowCommands: Command[] = []
    const dummyStep: Step = { name, commands: shadowCommands }
    buildFn(new StepBuilder(dummyStep))
    this.step.shadows.set(name, shadowCommands)

    return this
  }
}

/**
 * The core programmatic wrapper mapping the Vectr compilation pipeline
 * Offers a complete Builder Pattern API to compose, type-check, and sequentially execute complex infrastructure logic
*/
export class Vectr {

  private config: VectrConfig = {}
  private script: Script = {
    steps: new Map(),
    flow: [],
    env: new Map(),
    secrets: new Map()
  }

  /**
   * Evaluates and sets up the Vectr runtime
   * @param config Settings regarding visual debugging flags, SafeRuntime, debug, workers, and more
  */
  init(config: VectrConfig): this {
    this.config = config

    return this
  }

  /**
   * Explicitly mounts an environment variable into the Vectr script context
   * Strict mode enforcement: Implicit system variables (like process.env) NOT mounted here will trigger a Runtime Panic upon use
   * @param name The environment variable name
   * @param value The value of the environment variable
  */
  env(name: string, value: string): this {
    this.script.env.set(name, value)

    return this
  }

  /**
   * Injects a secret strictly into the runtime scope natively masking its output later down the script lifecycle
   * @param name Arbitrary local name to reference the secret safely securely
   * @param ref Object fetching secrets remotely, e.g. `{ type: 'env', name: 'NPM_TOKEN' }`
  */
  secret(name: string, ref: SecretReference): this {
    this.script.secrets.set(name, ref)

    return this
  }

  /**
   * Provisions a discrete step detailing exact commands, variables, and logic to process
   * Steps are physically NOT executed until `run()` is initialized, and only if declared natively down the pipeline inside `flow()`
   * @param name Name grouping the step operations
   * @param buildFn Closure sequentially capturing internal commands natively mapped to the StepBuilder API
  */
  step(name: string, buildFn: (step: StepBuilder) => void): this {

    const step: Step = { name, commands: [] }

    buildFn(new StepBuilder(step))
    this.script.steps.set(name, step)

    return this
  }

  /**
   * Solidifies the exact execution graph chaining previously established steps dynamically
   * Steps are ran incrementally matching exactly the parameter scale array layout defined here
   * @param stepNames Names matching previously defined objects mapped by `.step()`
  */
  flow(...stepNames: string[]): this {
    this.script.flow.push(...stepNames)

    return this
  }

  /**
   * Internally outputs the compiled AST (Abstract Syntax Tree) generated logically through the active API session
   * Extensively useful internally for compiler-related diagnosis operations
  */
  getScript(): Script {
    return this.script
  }

  /**
   * Unleashes the VectrRuntime initializing its I/O workers safely to execute the AST sequentially
   * Completely automates state-snapshots, mid-crash rollovers, parallel workers execution, and panic reporting
  */
  async run(): Promise<void> {

    const runtime = new VectrRuntime(this.script, this.config)

    await runtime.run()
  }
}