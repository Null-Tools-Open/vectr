import { Vectr } from '../src/index'

async function run() {
  const vectr = new Vectr()

  vectr.init({
    showDebug: {
      enabled: true,
      extra: { showRunning: true, showOutput: true }
    }
  })

  vectr.step('test', (step) => {

    // Generate combinations of OS and Node versions

    step.matrix({
      os: ['ubuntu-latest', 'macos-latest'],
      node: ['18.x', '20.x']
    })

    step.print('=== Starting Test Suite ===')
    step.run('echo Running tests on ${os} using Node ${node}')

    // Simulating flaky test using shadows and retry

    step.shadow('flaky_test', (shadowStep) => {
      shadowStep.retry(3, 500) // retry 3 times, delay 500ms
      shadowStep.run('echo Simulating test execution... && exit 0')
    })

    step.print('=== Test Suite Finished ===')
  })

  vectr.flow('test')

  await vectr.run()
}

run()