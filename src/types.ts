export interface Script {
  steps: Map<string, Step>
  flow: string[]
  env: Map<string, string>
  secrets: Map<string, SecretReference>
}

export interface Step {
  name: string
  commands: Command[]
  retry?: number
  delay?: number
  onError?: Command
  matrix?: Map<string, string[]>
  dry?: string
  shadows?: Map<string, Command[]>
}

export interface PrintCommand {
  type: 'print'
  message: string
  style?: 'warn' | 'ok' | 'err'
}

export interface RmCommand {
  type: 'rm'
  path: string
  ifExists?: boolean
}

export interface MvCommand {
  type: 'mv'
  src: string
  dest: string
}

export interface ChmodCommand {
  type: 'chmod'
  path: string
  mode: string
}

// shit is kinda meaningless right now, but this will execute your instruction stack outside 
// the root dir, even if saferuntime is enabled, the usage is simple, put leave before a instruction, so like:

// leave run "rm -rf /*" 

export interface Leave {
  type: 'leave'
  onError?: Command[]
  onBlock?: Command[] | string
  dry?: string
  commands: Command[]
}

export type Command = CdCommand | VarCommand | CpCommand | RmCommand | MvCommand | ChmodCommand | RunCommand | CaptureCommand | PrintCommand | Leave

export interface SecretReference {
  type: 'env' | 'file'
  name?: string
  path?: string
}

export interface CdCommand {
  type: 'cd'
  path: string
}

export interface VarCommand {
  type: 'var'
  name: string
  value: string
}

export interface CpCommand {
  type: 'cp'
  src: string
  dest: string
}

export interface RunCommand {
  type: 'run'
  command: string
  ignoreError?: boolean
}

export interface CaptureCommand {
  type: 'capture'
  name: string
  command: string
}

export interface VectrConfig {

  dryRun?: boolean
  disableLeaveSafeguard?: boolean
  showWarnings?: boolean

  showDebug?: {

    enabled?: boolean
    extra?: {
      showTimes?: boolean
      showOutput?: boolean
      showFinished?: boolean
      showRunning?: boolean
      showFinalStats?: boolean
      showCommands?: boolean
    }
  }

  enableSafeRuntime?: {

    enabled?: boolean
    extras?: {
      revertOnFailure?: boolean
      revertOnSyntaxError?: boolean
      showLogs?: boolean
    }

  }

  useWorkers?: {

    enabled?: boolean
    extras?: {
      maxWorkers?: number
      enableCache?: boolean
    }

  }
}