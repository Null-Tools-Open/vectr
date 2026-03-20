import { Vectr } from '../src/index'

async function run() {
  const vectr = new Vectr()

  vectr.init({
    showDebug: {
      enabled: true,
      extra: { showTimes: true, showOutput: true, showFinished: true }
    }
  })

  vectr.env('BUILD_ENV', 'production')

  vectr.step('prepare', (step) => {

    // Capture command output to a variable

    step.capture('git_hash', 'git rev-parse --short HEAD || echo "unknown"')
    step.var('build_version', '1.0.0-${git_hash}')
    step.print('Preparing build for ${build_version} in ${BUILD_ENV} mode')
  })

  vectr.step('build', (step) => {

    // Isolated shadow step for a non-critical task

    step.shadow('lint', (shadow) => {
      shadow.run('echo "Linting codebase..."')
    })

    // A command that creates our build artifact

    step.run('mkdir -p dist')
    step.run('echo "Build result: ${build_version}" > dist/app.js')

    // Leaving the safe runtime for a global command (e.g. installing a global logger)
    // Normally, writing to /tmp or outside CWD might be blocked, but leave allows it

    step.leave(
      [{ type: 'run', command: 'echo "Global install dummy"' }],
      "echo 'SafeRuntime blocked this global action'",
      [{ type: 'print', message: 'Fallback for global action...' }]
    )
  })

  vectr.step('cleanup', (step) => {
    step.run('rm -rf dist')
    step.print('Cleanup complete.')
  })

  vectr.flow('prepare', 'build', 'cleanup')

  console.log('--- Complex Pipeline Started ---')
  await vectr.run()
}

run()