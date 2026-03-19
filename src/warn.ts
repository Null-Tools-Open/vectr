export class VectrWarning {

  constructor(message: string) {

    console.warn(`\n\x1b[43m\x1b[30m [Vectr] WARN \x1b[0m\n\x1b[33m${message}\x1b[0m\n`)
  }
}