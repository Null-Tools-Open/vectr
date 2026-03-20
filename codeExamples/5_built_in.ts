import { Vectr } from '../src'

async function run() {

    const vectr = new Vectr()

    vectr.init({
        showDebug: {
            enabled: true,
            extra: { showCommands: true, showTimes: true, showOutput: true }
        }
    })

    vectr.step('operator_test', (step) => {

        step.warn('Testing native file operators!')

        // 1. Create a setup dir

        step.run('mkdir -p ./tmp/example_dir')
        step.run('echo "Hello World" > ./tmp/example_dir/test.txt')

        // 2. Chmod natively

        step.chmod('./tmp/example_dir/test.txt', '0777')

        // 3. Move natively

        step.mv('./tmp/example_dir', './tmp/example_dir_moved')

        // 4. Remove natively with globs

        step.rm('./tmp/example_dir_moved/**', true)
        step.rm('./tmp/example_dir_moved')

        step.ok('Files cleaned up cleanly using native workers!')
    })

    vectr.flow('operator_test')

    await vectr.run()
}

run()