import { Script, Step, SecretReference, VectrConfig } from './types'
import { VectrSyntaxError } from './error'
import { VectrWarning } from './warn'

export function parse(input: string, config?: VectrConfig): Script {

  const lines = input.split('\n')
  const script: Script = {
    steps: new Map<string, Step>(),
    flow: [],
    env: new Map<string, string>(),
    secrets: new Map<string, SecretReference>()
  }

  let currentStep: Step | null = null
  let currentBlock: 'none' | 'step' | 'flow' | 'env' | 'secret' = 'none'
  let inMatrix = false
  let currentShadow: string | null = null
  let shadowIndent = 0

  for (let i = 0; i < lines.length; i++) {

    const rawLine = lines[i]
    const indentMatch = rawLine.match(/^\s*/)
    const indent = indentMatch ? indentMatch[0].length : 0
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) continue

    if (line.startsWith('env:')) {
      currentBlock = 'env'
      currentStep = null
      inMatrix = false
      currentShadow = null
      continue
    }

    if (line.startsWith('secret:')) {
      currentBlock = 'secret'
      currentStep = null
      inMatrix = false
      currentShadow = null
      continue
    }

    if (line.startsWith('step ')) {
      currentBlock = 'step'
      inMatrix = false
      currentShadow = null
      const stepName = line.substring(5, line.length - 1).trim()
      currentStep = { name: stepName, commands: [] }
      script.steps.set(stepName, currentStep)
      continue
    }

    if (line.startsWith('flow:')) {
      currentBlock = 'flow'
      currentStep = null
      inMatrix = false
      currentShadow = null

      const rest = line.substring(5).trim()
      if (rest) {
        script.flow.push(...rest.split('=>').map(s => s.trim()).filter(Boolean))
      }
      continue
    }

    if (currentBlock === 'flow') {
      script.flow.push(...line.split('=>').map(s => s.trim()).filter(Boolean))
      continue
    }

    if (currentBlock === 'env') {
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/)
      if (match) {
        const name = match[1]
        const value = match[2].trim().replace(/^['"](.*)['"]$/, '$1')
        script.env.set(name, value)
      } else {
        throw new VectrSyntaxError(`Invalid env syntax at line ${i + 1}: ${rawLine}`)
      }
      continue
    }

    if (currentBlock === 'secret') {
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+from\s+(.*)$/)
      if (match) {
        const name = match[1]
        const source = match[2].trim().replace(/^['"](.*)['"]$/, '$1')
        if (source.startsWith('$')) {
          script.secrets.set(name, { type: 'env', name: source.substring(1) })
        } else {
          script.secrets.set(name, { type: 'file', path: source })
        }
      } else {
        throw new VectrSyntaxError(`Invalid secret syntax at line ${i + 1}: ${rawLine}`)
      }
      continue
    }

    if (currentBlock === 'step' && currentStep) {

      if (currentShadow && indent <= shadowIndent) {
        currentShadow = null
      }

      const targetCommands = currentShadow ? currentStep.shadows!.get(currentShadow)! : currentStep.commands

      if (line.startsWith('matrix:')) {

        inMatrix = true
        currentStep.matrix = new Map<string, string[]>()

        continue
      }

      if (inMatrix) {

        const matrixMatch = line.match(/^([a-zA-Z0-9_]+):\s*\[(.*)\]$/)

        if (matrixMatch) {

          const key = matrixMatch[1]
          const values = matrixMatch[2].split(',').map(s => s.trim().replace(/^['"](.*)['"]$/, '$1')).filter(Boolean)

          currentStep.matrix!.set(key, values)

          continue
        } else {

          inMatrix = false
        }
      }
      if (line.startsWith('shadow ')) {

        const shadowMatch = line.match(/^shadow\s+([a-zA-Z0-9_]+):$/)

        if (shadowMatch) {

          currentShadow = shadowMatch[1]
          shadowIndent = indent

          if (!currentStep.shadows) currentStep.shadows = new Map()

          currentStep.shadows.set(currentShadow, [])

          continue
        }
      }
      if (line.startsWith('dry:')) {
        let cmdStr = line.substring(4).trim()
        if (cmdStr.startsWith('run ')) {
          cmdStr = cmdStr.substring(4).trim().replace(/^['"](.*)['"]$/, '$1')
        } else if ((cmdStr.startsWith('"') && cmdStr.endsWith('"')) || (cmdStr.startsWith("'") && cmdStr.endsWith("'"))) {
          cmdStr = cmdStr.substring(1, cmdStr.length - 1)
        }
        currentStep.dry = cmdStr

        continue
      }
      if (line.startsWith('retry ')) {
        const match = line.match(/^retry\s+(\d+)\s+delay\s+(\d+)(s|ms)$/)
        if (match) {
          currentStep.retry = parseInt(match[1], 10)
          currentStep.delay = parseInt(match[2], 10) * (match[3] === 's' ? 1000 : 1)
        } else {
          throw new VectrSyntaxError(`Invalid retry syntax at line ${i + 1}: ${rawLine}`)
        }
        continue
      }
      if (line.startsWith('on_error:')) {
        const restLine = line.substring(9).trim()
        if (restLine.startsWith('run ')) {
          const matchRun = restLine.match(/^run\s+['"](.*?)['"]$/)
          if (matchRun) {
            currentStep.onError = { type: 'run', command: matchRun[1] }
          } else {
            throw new VectrSyntaxError(`Invalid on_error run command syntax at line ${i + 1}: ${rawLine}`)
          }
        } else {
          throw new VectrSyntaxError(`Invalid on_error syntax at line ${i + 1}: ${rawLine}`)
        }
        continue
      }
      if (line.startsWith('cd ')) {
        const path = line.substring(3).trim().replace(/^['"](.*)['"]$/, '$1')
        targetCommands.push({ type: 'cd', path })
      } else if (line.startsWith('var ')) {
        const matchCapture = line.match(/^var\s+([a-zA-Z0-9_]+)\s*=\s*capture\s+(.*)$/)
        if (matchCapture) {
          const name = matchCapture[1]
          const command = matchCapture[2].trim().replace(/^['"](.*)['"]$/, '$1')
          targetCommands.push({ type: 'capture', name, command })
          continue
        }
        const match = line.match(/^var\s+([a-zA-Z0-9_]+)\s*=\s*(.*)$/)
        if (match) {
          const name = match[1]
          const value = match[2].trim().replace(/^['"](.*)['"]$/, '$1')
          targetCommands.push({ type: 'var', name, value })
        } else {
          throw new VectrSyntaxError(`Invalid var syntax at line ${i + 1}: ${rawLine}`)
        }
      } else if (line.startsWith('cp ')) {
        const match = line.match(/^cp\s+(.+?)\s*=>\s*(.+)$/)
        if (match) {
          const src = match[1].trim().replace(/^['"](.*)['"]$/, '$1')
          const dest = match[2].trim().replace(/^['"](.*)['"]$/, '$1')
          targetCommands.push({ type: 'cp', src, dest })
        } else {
          throw new VectrSyntaxError(`Invalid cp syntax at line ${i + 1}: ${rawLine}`)
        }
      } else if (line.startsWith('run ')) {
        const match = line.match(/^run\s+['"](.*?)['"](?:\s+(ignore_error))?$/)
        if (match) {
          const command = match[1]
          const ignoreError = match[2] === 'ignore_error'
          targetCommands.push({ type: 'run', command, ignoreError })
        } else {
          throw new VectrSyntaxError(`Invalid run syntax at line ${i + 1}: ${rawLine}`)
        }
      } else {
        throw new VectrSyntaxError(`Unknown command at line ${i + 1}: ${rawLine}`)
      }
    } else {
      throw new VectrSyntaxError(`Command outside of step or flow at line ${i + 1}: ${rawLine}`)
    }
  }

  if (config?.showWarnings !== false) {
    for (const stepName of script.steps.keys()) {
      if (!script.flow.includes(stepName)) {
        new VectrWarning(`Step declared but never used in flow: ${stepName}`)
      }
    }
  }

  return script
}