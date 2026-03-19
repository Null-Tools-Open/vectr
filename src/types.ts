export type SecretRef = { type: 'env', name: string } | { type: 'file', path: string }

export interface Script {
  env: Map<string, string>
  secrets: Map<string, SecretRef>
  steps: Map<string, Step>
  flow: string[]
}

export interface Step {
  name: string
  commands: Command[]
  retry?: number
  delay?: number
  onError?: Command
}

export type Command = CdCommand | VarCommand | CpCommand | RunCommand | CaptureCommand

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