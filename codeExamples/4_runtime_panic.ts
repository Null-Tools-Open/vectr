import { Vectr } from '../src/index'

async function run() {
    const vectr = new Vectr()

    vectr.init({
        enableSafeRuntime: {
            enabled: true
        },
        showDebug: {
            enabled: true,
            extra: { showOutput: true }
        }
    })

    vectr.step('leak_test', (step) => {
        step.print('Attempting to read system PATH variable...')

        // We try to access a system environment variable that wasnt 
        // explicitly passed via vectr.env() or a secret block
        // This will trigger Vectr's strict runtime panic
        step.run('echo "My system path is: ${PATH}"')
    })

    vectr.flow('leak_test')

    await vectr.run()
}

run()