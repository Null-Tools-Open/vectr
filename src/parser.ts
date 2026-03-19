import { Script, Step, VectrConfig } from './types'
import { VectrSyntaxError } from './error'
import { VectrWarning } from './warn'

export function parse(input: string, config?: VectrConfig): Script {

  const lines = input.split('\n')
  const script: Script = {
    steps: new Map<string, Step>(),
    flow: []
  }

  let currentStep: Step | null = null
  let inFlow = false

  for (let i = 0; i < lines.length; i++) {

    const rawLine = lines[i]
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) continue

    if (line.startsWith('step ')) {
      inFlow = false
      const stepName = line.substring(5, line.length - 1).trim()
      currentStep = { name: stepName, commands: [] }
      script.steps.set(stepName, currentStep)
      continue
    }

    if (line.startsWith('flow:')) {
      inFlow = true
      currentStep = null

      const rest = line.substring(5).trim()
      if (rest) {
        script.flow.push(...rest.split('=>').map(s => s.trim()).filter(Boolean))
      }
      continue
    }

    if (inFlow) {
      script.flow.push(...line.split('=>').map(s => s.trim()).filter(Boolean))
      continue
    }

    if (currentStep) {
      if (line.startsWith('cd ')) {
        const path = line.substring(3).trim().replace(/^['"](.*)['"]$/, '$1')
        currentStep.commands.push({ type: 'cd', path })
      } else if (line.startsWith('var ')) {
        const match = line.match(/^var\s+([a-zA-Z0-9_]+)\s*=\s*(.*)$/)
        if (match) {
          const name = match[1]
          const value = match[2].trim().replace(/^['"](.*)['"]$/, '$1')
          currentStep.commands.push({ type: 'var', name, value })
        } else {
          throw new VectrSyntaxError(`Invalid var syntax at line ${i + 1}: ${rawLine}`)
        }
      } else if (line.startsWith('cp ')) {
        const match = line.match(/^cp\s+(.+?)\s*=>\s*(.+)$/)
        if (match) {
          const src = match[1].trim().replace(/^['"](.*)['"]$/, '$1')
          const dest = match[2].trim().replace(/^['"](.*)['"]$/, '$1')
          currentStep.commands.push({ type: 'cp', src, dest })
        } else {
          throw new VectrSyntaxError(`Invalid cp syntax at line ${i + 1}: ${rawLine}`)
        }
      } else if (line.startsWith('run ')) {
        const command = line.substring(4).trim().replace(/^['"](.*)['"]$/, '$1')
        currentStep.commands.push({ type: 'run', command })
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