# Vectr 

Secure automation runtime designed to replace messy bash scripts with clean, predictable `.vcr` files

Got tired of standard shell scripts failing silently halfway through and leaving a corrupted workspace behind? Vectr parses your entire execution flow upfront, runs heavy I/O asynchronously, and guarantees safety via a native Snapshot Rollback system. When a command fails, Vectr just undoes everything. 

## Highlight Features
- **Zero-Trash Rollbacks**: If a step fails mid-execution (e.g. `exit 1`), `SafeRuntime` restores your entire workspace snapshot in milliseconds. No more cleaning up broken build folders.
- **Fail-Fast Parser**: Syntax is checked before *anything* touches your disk. Forget about discovering a typo 20 minutes into a deployment script.
- **Non-blocking I/O (`useWorkers`)**: Operations like massive `cp` copies use async `fs.promises` under the hood. Moving thousands of files doesn't block the event loop.
- **Path Traversal Protection**: `SafeRuntime` locks execution strictly inside your working directory. No accidental modifying of `/etc` or files outside your repo.

## Quick Start
Create a `build.vcr` file:

```vectr
step prepare:
  run "mkdir -p ./dist"
  run "echo 'building...'"
  var src = "./dist"

step backup:
  cp src => "./dist_backup"

flow:
  prepare => backup
```

Run it via the CLI:
```bash
npx vectr build.vcr
```

- **Environment & Secrets**: Load environment variables and secure secrets natively
  ```vectr
  env:
    NODE_ENV = "production"

  secret:
    NPM_TOKEN from $NPM_TOKEN_ENV
    DB_PASS from "./secrets.txt"
  ```
- **Matrix Execution**: Run steps across multiple combinations effortlessly
  ```vectr
  step test:
    matrix:
      os: [ubuntu, macos]
      node: [16, 18]
    run "echo Testing on ${os} with Node ${node}"
  ```
- **Resilience & Control**: Built-in `retry`, `delay`, and `on_error` fallbacks
  ```vectr
  step deploy:
    retry 3 delay 5s
    on_error: run "echo 'Deployment failed'"
    run "npm run deploy"
  ```
- **Variable Capture**: Capture command outputs into variables
  ```vectr
  step info:
    var git_hash = capture "git rev-parse HEAD"
    run "echo Building commit ${git_hash}"
  ```
- **Shadow Steps**: Isolate commands within a step to prevent full step failures from minor issues
  ```vectr
  step build:
    shadow optional_task:
      run "echo 'This failure will be isolated'"
    run "echo 'Main build'"
  ```
- **Escape SafeRuntime (`leave`)**: Intentionally bypass path protection for global commands (when allowed by config)
  ```vectr
  step global_install:
    leave run "npm i -g yarn" onBlock "echo 'Blocked'" onError run "echo 'Fallback'"
  ```

## Configuration
Customize execution speed, debug logs, and runtime safety using `vectr.config.mjs` in your project root

```javascript
export default {
  // Toggle compiler warnings for unused steps
  showWarnings: true,
  
  showDebug: {
    enabled: true,
    extra: {
      showTimes: true, // "Finished step (12ms)"
      showOutput: true, // "  cp ./a => ./b"
      showFinished: true,
      showCommands: false // stdio 'inherit' vs 'ignore'
    }
  },
  
  enableSafeRuntime: {
    enabled: true,
    extras: {
      revertOnFailure: true, // Auto-rollback on crash
      showLogs: true
    }
  },
  
  useWorkers: {
    enabled: true // Enables async I/O and snapshoting
  }
};
```