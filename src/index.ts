export * from './types'
export * from './parser'
export * from './runtime'
export * from './warn'

import { parse } from './parser'
import { VectrRuntime } from './runtime'
import { VectrConfig } from './types'

export async function runVectrScript(scriptContent: string, config: VectrConfig = {}) {

  const ast = parse(scriptContent, config)

  const runtime = new VectrRuntime(ast, config)

  await runtime.run()
}