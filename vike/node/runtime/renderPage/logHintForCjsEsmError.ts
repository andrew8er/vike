export { logHintForCjsEsmError }
// For ./logHintForCjsEsmError.spec.ts
export { isCjsEsmError }

import pc from '@brillout/picocolors'

function logHintForCjsEsmError(error: unknown): void {
  const res = isCjsEsmError(error)
  if (!res) return
  const packageName = res === true ? null : res
  const errMsg = [
    `The error above seems to be a CJS/ESM issue${!packageName ? '' : ` with the package ${pc.cyan(packageName)}`}`,
    `consider ${!packageName ? 'using' : `adding ${pc.cyan(`'${packageName}'`)} to`} ${pc.cyan('ssr.noExternal')}`,
    'see https://vike.dev/broken-npm-package'
  ].join(', ')
  console.error(errMsg)
}

/**
 * `false` -> noop
 * `true` -> generic message
 * `'some-npm-package'` -> add some-npm-package to `ssr.noExternal`
 */
function isCjsEsmError(error: unknown): boolean | string {
  const errString = parseError(error)
  if (!errString) {
    return false
  }

  const shouldShowMessage = new RegExp(
    [
      `Error: Element type is invalid`,
      `TypeError: require is not a function`,
      // `TypeError: Cannot read properties of undefined`,
      `SyntaxError: Named export`,
      `SyntaxError: Cannot use import statement outside a module`,
      `ReferenceError: exports is not defined.*node_modules`,
      `ERR_UNSUPPORTED_DIR_IMPORT.*node_modules`,
      `ERR_UNKNOWN_FILE_EXTENSION.*node_modules`,
      `ERR_REQUIRE_ESM`
    ].join('|'),
    's'
  )
  const shouldParsePackageName = new RegExp(
    [
      `SyntaxError: Cannot use import statement outside a module`,
      `SyntaxError: Named export`,
      `ERR_UNSUPPORTED_DIR_IMPORT.*node_modules`,
      `ERR_UNKNOWN_FILE_EXTENSION.*node_modules`,
      `ReferenceError: exports is not defined.*node_modules`
    ].join('|'),
    's'
  )

  if (shouldShowMessage.test(errString)) {
    if (shouldParsePackageName.test(errString)) {
      return parsePackageName(errString)
    }
    return true
  }

  return false
}

function parseError(error: unknown) {
  if (!error) {
    return
  }
  let parsed = ''

  if (typeof error === 'string') {
    parsed = error
  } else if (typeof error === 'object') {
    if ('name' in error && typeof error.name === 'string') {
      parsed = `${parsed}\n${error.name}`
    }

    if ('message' in error && typeof error.message === 'string') {
      parsed = `${parsed}\n${error.message}`
    }

    if ('stack' in error && typeof error.stack === 'string') {
      parsed = `${parsed}\n${error.stack}`
    }
  }

  return parsed
}

function parsePackageName(errString: string) {
  let packageName = ''
  const match = /import.*?from ?"(.*?)"/.exec(errString)
  if (match?.length && typeof match[1] === 'string') {
    packageName = match[1]
  }
  if (!packageName) {
    const firstNodeModulesLine = errString.split('\n').find((line) => line.includes('node_modules/'))

    if (firstNodeModulesLine) {
      packageName = firstNodeModulesLine.split('node_modules/').pop()!.split('/').slice(0, 2).join('/')
    }
  }
  const isNamespacedPackage = packageName.startsWith('@')
  if (!isNamespacedPackage) {
    packageName = packageName.split('/').shift()!
  }

  if (packageName) {
    if (!packageName.startsWith('"')) {
      packageName = `"${packageName}`
    }
    if (!packageName.endsWith('"')) {
      packageName = `${packageName}"`
    }
  }
  return packageName
}
