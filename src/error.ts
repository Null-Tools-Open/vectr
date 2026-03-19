import * as fs from 'fs'

export class VectrError extends Error {

    constructor(message: string, public type: string = 'VectrError') {
        super(message)
        this.name = type
    }
}

export class VectrSyntaxError extends VectrError {

    constructor(message: string) {
        super(message, 'VectrSyntaxError')
    }
}

export class RollbackManager {

    private actions: (() => void)[] = []

    constructor(private showLogs: boolean = true) { }

    public add(action: () => void) {
        this.actions.push(action)
    }

    public rollback() {

        if (this.actions.length === 0) return

        if (this.showLogs) {
            console.log(`\n\x1b[33m[Vectr] Rolling back changes...\x1b[0m`)
        }

        while (this.actions.length > 0) {

            const action = this.actions.pop()

            if (action) {
                try {
                    action()
                } catch (e) {
                    if (this.showLogs) {
                        console.warn(`\x1b[90m  ↳ [Rollback] Failed to revert an action\x1b[0m`)
                    }
                }
            }
        }
    }

    public registerCp(dest: string) {

        if (!fs.existsSync(dest)) {

            this.add(() => {

                if (fs.existsSync(dest)) {
                    if (this.showLogs) {
                        console.log(`\x1b[90m  ↳ [Rollback] Removing copied path: ${dest}\x1b[0m`)
                    }
                    fs.rmSync(dest, { recursive: true, force: true })
                }
            })
        }
    }
}