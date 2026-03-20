import { Vectr } from '../src/index'
import * as fs from 'fs'

async function run() {

  const vectr = new Vectr()

  vectr.init({
    enableSafeRuntime: {
      enabled: true,
      extras: { revertOnFailure: true, showLogs: true }
    },
    useWorkers: { enabled: true },
    showDebug: { enabled: true, extra: { showOutput: true } }
  })

  vectr.step('setup', (step) => {
    step.print('Creating a dummy file...')
    step.run('mkdir -p test_dir')
    step.run('echo "Important data" > test_dir/data.txt')
  })

  // This step will fail midway and trigger a snapshot rollback

  vectr.step('failing_step', (step) => {
    step.print('Doing some work...')
    step.run('echo "Corrupting data..." > test_dir/data.txt')
    step.print('Oh no, an error occurred mid-step!')
    step.run('exit 1') // Crash here
  })

  vectr.flow('setup', 'failing_step')

  await vectr.run()

}

run()