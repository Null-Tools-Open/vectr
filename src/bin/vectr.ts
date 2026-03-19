#!/usr/bin/env node

import * as fs from 'fs'
import * as path from 'path'
import { runVectrScript } from '../index'

import { pathToFileURL } from 'url'

(async () => {

  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.error("Usage: vectr <script.vcr>")
    process.exit(1)
  }

  const scriptPath = path.resolve(process.cwd(), args[0])

  if (!fs.existsSync(scriptPath)) {
    console.error(`Error: Script file not found: ${scriptPath}`)
    process.exit(1)
  }

  const content = fs.readFileSync(scriptPath, 'utf-8')

  let config: any = {}
  const configPath = path.resolve(process.cwd(), 'vectr.config.mjs')

  if (fs.existsSync(configPath)) {
    try {
      const configModule = await eval(`import('${pathToFileURL(configPath).href}')`)
      config = configModule.default || configModule
    } catch (err: any) {
      console.warn(`\x1b[33m[Vectr]\x1b[0m Failed to load config: ${err.message}`)
    }
  }

  try {

    await runVectrScript(content, config)

  } catch (error: any) {

    const isPanic = config?.enableSafeRuntime?.enabled || (error.name && error.name.includes('Vectr'))

    if (isPanic) {
      console.error(`\n\x1b[41m\x1b[37m [Vectr] RUNTIME PANIC \x1b[0m\n\x1b[31m${error.message}\x1b[0m\n`)
    } else {
      console.error(`\x1b[31m[Vectr]\x1b[0m Execution failed: ${error.message}`)
    }
    process.exit(1)
  }
})()