import chalk from 'chalk'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

import { fileExists } from './file-exists'
import { recursiveReadDir } from './recursive-readdir'
import { resolveRequest } from './resolve-request'

const writeFile = promisify(fs.writeFile)
const readFile = promisify(fs.readFile)

function writeJson(fileName: string, object: object): Promise<void> {
  return writeFile(
    fileName,
    JSON.stringify(object, null, 2).replace(/\n/g, os.EOL) + os.EOL
  )
}

async function hasTypeScript(dir: string): Promise<boolean> {
  const typescriptFiles = await recursiveReadDir(
    dir,
    /.*\.(ts|tsx)$/,
    /(node_modules|.*\.d\.ts)/
  )

  return typescriptFiles.length > 0
}

async function checkDependencies({
  dir,
  isYarn,
}: {
  dir: string
  isYarn: boolean
}) {
  const requiredPackages = [
    { file: 'typescript', pkg: 'typescript' },
    { file: '@types/react/index.d.ts', pkg: '@types/react' },
    { file: '@types/node/index.d.ts', pkg: '@types/node' },
  ]

  let resolutions = new Map<string, string>()

  const missingPackages = requiredPackages.filter(p => {
    try {
      resolutions.set(p.pkg, resolveRequest(p.file, `${dir}/`))
      return false
    } catch (_) {
      return true
    }
  })

  if (missingPackages.length < 1) {
    return resolutions.get('typescript')!
  }

  const packagesHuman = missingPackages
    .map(
      (p, index, { length }) =>
        (index > 0
          ? index === length - 1
            ? length > 2
              ? ', and '
              : ' and '
            : ', '
          : '') + p.pkg
    )
    .join('')
  const packagesCli = missingPackages.map(p => p.pkg).join(' ')

  console.error(
    chalk.bold.red(
      `It looks like you're trying to use TypeScript but do not have the required package(s) installed.`
    )
  )
  console.error()
  console.error(
    chalk.bold(`Please install ${chalk.bold(packagesHuman)} by running:`)
  )
  console.error()
  console.error(
    `\t${chalk.bold.cyan(
      (isYarn ? 'yarn add --dev' : 'npm install --save-dev') + ' ' + packagesCli
    )}`
  )
  console.error()
  console.error(
    chalk.bold(
      'If you are not trying to use TypeScript, please remove the ' +
        chalk.cyan('tsconfig.json') +
        ' file from your package root (and any TypeScript files).'
    )
  )
  console.error()
  process.exit(1)
}

export async function verifyTypeScriptSetup(
  dir: string,
  pagesDir: string
): Promise<void> {
  const tsConfigPath = path.join(dir, 'tsconfig.json')
  const yarnLockFile = path.join(dir, 'yarn.lock')

  const hasTsConfig = await fileExists(tsConfigPath)
  const isYarn = await fileExists(yarnLockFile)

  let firstTimeSetup = false
  if (hasTsConfig) {
    const tsConfig = await readFile(tsConfigPath, 'utf8').then(val =>
      val.trim()
    )
    firstTimeSetup = tsConfig === '' || tsConfig === '{}'
  } else {
    const hasTypeScriptFiles = await hasTypeScript(pagesDir)
    if (hasTypeScriptFiles) {
      firstTimeSetup = true
    } else {
      return
    }
  }

  const tsPath = await checkDependencies({ dir, isYarn })
  const ts = (await import(tsPath)) as typeof import('typescript')

  const compilerOptions: any = {
    // These are suggested values and will be set when not present in the
    // tsconfig.json
    // 'parsedValue' matches the output value from ts.parseJsonConfigFileContent()
    target: {
      parsedValue: ts.ScriptTarget.ES5,
      suggested: 'es5',
    },
    lib: { suggested: ['dom', 'dom.iterable', 'esnext'] },
    allowJs: { suggested: true },
    skipLibCheck: { suggested: true },
    strict: { suggested: false },
    forceConsistentCasingInFileNames: { suggested: true },
    noEmit: { suggested: true },

    // These values are required and cannot be changed by the user
    // Keep this in sync with the webpack config
    esModuleInterop: {
      value: true,
      reason: 'requirement for babel',
    },
    module: {
      parsedValue: ts.ModuleKind.ESNext,
      value: 'esnext',
      reason: 'for dynamic import() support',
    },
    moduleResolution: {
      parsedValue: ts.ModuleResolutionKind.NodeJs,
      value: 'node',
      reason: 'to match webpack resolution',
    },
    resolveJsonModule: { value: true },
    isolatedModules: {
      value: true,
      reason: 'requirement for babel',
    },
    jsx: { parsedValue: ts.JsxEmit.Preserve, value: 'preserve' },
  }

  const formatDiagnosticHost = {
    getCanonicalFileName: (fileName: string) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => os.EOL,
  }

  if (firstTimeSetup) {
    console.log(
      chalk.yellow(
        `We detected TypeScript in your project and created a ${chalk.bold(
          'tsconfig.json'
        )} file for you.`
      )
    )
    console.log()

    await writeJson(tsConfigPath, {})
  }

  const messages = []
  let appTsConfig
  let parsedTsConfig
  let parsedCompilerOptions
  try {
    const { config: readTsConfig, error } = ts.readConfigFile(
      tsConfigPath,
      ts.sys.readFile
    )

    if (error) {
      throw new Error(ts.formatDiagnostic(error, formatDiagnosticHost))
    }

    appTsConfig = readTsConfig

    // Get TS to parse and resolve any "extends"
    // Calling this function also mutates the tsconfig, adding in "include" and
    // "exclude", but the compilerOptions remain untouched
    parsedTsConfig = JSON.parse(JSON.stringify(readTsConfig))
    const result = ts.parseJsonConfigFileContent(
      parsedTsConfig,
      ts.sys,
      path.dirname(tsConfigPath)
    )

    if (result.errors) {
      result.errors = result.errors.filter(
        ({ code }) =>
          // No inputs were found in config file
          code !== 18003
      )
    }

    if (result.errors?.length) {
      throw new Error(
        ts.formatDiagnostic(result.errors[0], formatDiagnosticHost)
      )
    }

    parsedCompilerOptions = result.options
  } catch (e) {
    if (e && e.name === 'SyntaxError') {
      console.error(
        chalk.red.bold(
          'Could not parse',
          chalk.cyan('tsconfig.json') + '.',
          'Please make sure it contains syntactically correct JSON.'
        )
      )
    }

    console.info(e?.message ? `${e.message}` : '')
    process.exit(1)
    return
  }

  if (appTsConfig.compilerOptions == null) {
    appTsConfig.compilerOptions = {}
    firstTimeSetup = true
  }

  for (const option of Object.keys(compilerOptions)) {
    const { parsedValue, value, suggested, reason } = compilerOptions[option]

    const valueToCheck = parsedValue === undefined ? value : parsedValue
    const coloredOption = chalk.cyan('compilerOptions.' + option)

    if (suggested != null) {
      if (parsedCompilerOptions[option] === undefined) {
        appTsConfig.compilerOptions[option] = suggested
        messages.push(
          `${coloredOption} to be ${chalk.bold(
            'suggested'
          )} value: ${chalk.cyan.bold(suggested)} (this can be changed)`
        )
      }
    } else if (parsedCompilerOptions[option] !== valueToCheck) {
      appTsConfig.compilerOptions[option] = value
      messages.push(
        `${coloredOption} ${chalk.bold(
          valueToCheck == null ? 'must not' : 'must'
        )} be ${valueToCheck == null ? 'set' : chalk.cyan.bold(value)}` +
          (reason != null ? ` (${reason})` : '')
      )
    }
  }

  // tsconfig will have the merged "include" and "exclude" by this point
  if (parsedTsConfig.exclude == null) {
    appTsConfig.exclude = ['node_modules']
  }

  if (parsedTsConfig.include == null) {
    appTsConfig.include = ['next-env.d.ts', '**/*.ts', '**/*.tsx']
  }

  if (messages.length > 0) {
    if (firstTimeSetup) {
      console.info(
        chalk.bold(
          'Your',
          chalk.cyan('tsconfig.json'),
          'has been populated with default values.'
        )
      )
      console.info()
    } else {
      console.warn(
        chalk.bold(
          'The following changes are being made to your',
          chalk.cyan('tsconfig.json'),
          'file:'
        )
      )
      messages.forEach(message => {
        console.warn('  - ' + message)
      })
      console.warn()
    }
    await writeJson(tsConfigPath, appTsConfig)
  }

  // Reference `next` types
  const appTypeDeclarations = path.join(dir, 'next-env.d.ts')
  if (!fs.existsSync(appTypeDeclarations)) {
    fs.writeFileSync(
      appTypeDeclarations,
      '/// <reference types="next" />' +
        os.EOL +
        '/// <reference types="next/types/global" />' +
        os.EOL
    )
  }
}
