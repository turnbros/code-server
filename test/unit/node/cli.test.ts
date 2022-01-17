import { Level, logger } from "@coder/logger"
import { promises as fs } from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import {
  UserProvidedArgs,
  bindAddrFromArgs,
  defaultConfigFile,
  parse,
  readSocketPath,
  setDefaults,
  shouldOpenInExistingInstance,
  splitOnFirstEquals,
  toVsCodeArgs,
} from "../../../src/node/cli"
import { shouldSpawnCliProcess } from "../../../src/node/main"
import { generatePassword, paths } from "../../../src/node/util"
import { clean, useEnv, tmpdir } from "../../utils/helpers"

// The parser should not set any defaults so the caller can determine what
// values the user actually set. These are only set after explicitly calling
// `setDefaults`.
const defaults = {
  auth: "password",
  host: "localhost",
  port: 8080,
  "proxy-domain": [],
  usingEnvPassword: false,
  usingEnvHashedPassword: false,
  "extensions-dir": path.join(paths.data, "extensions"),
  "user-data-dir": paths.data,
  _: [],
}

describe("parser", () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL
    delete process.env.PASSWORD
    console.log = jest.fn()
  })

  it("should parse nothing", async () => {
    expect(parse([])).toStrictEqual({})
  })

  it("should parse all available options", async () => {
    expect(
      parse(
        [
          ["--enable", "feature1"],
          ["--enable", "feature2"],

          "--bind-addr=192.169.0.1:8080",

          ["--auth", "none"],

          ["--extensions-dir", "path/to/ext/dir"],

          ["--builtin-extensions-dir", "path/to/builtin/ext/dir"],

          "1",
          "--verbose",
          "2",

          ["--locale", "ja"],

          ["--log", "error"],

          "--help",

          "--open",

          "--socket=mumble",

          "3",

          ["--user-data-dir", "path/to/user/dir"],

          ["--cert=path/to/cert", "--cert-key", "path/to/cert/key"],

          "--version",

          "--json",

          "--port=8081",

          ["--host", "0.0.0.0"],
          "4",
          "--",
          "--5",
        ].flat(),
      ),
    ).toEqual({
      _: ["1", "2", "3", "4", "--5"],
      auth: "none",
      "builtin-extensions-dir": path.resolve("path/to/builtin/ext/dir"),
      "extensions-dir": path.resolve("path/to/ext/dir"),
      "user-data-dir": path.resolve("path/to/user/dir"),
      "cert-key": path.resolve("path/to/cert/key"),
      cert: {
        value: path.resolve("path/to/cert"),
      },
      enable: ["feature1", "feature2"],
      help: true,
      host: "0.0.0.0",
      json: true,
      locale: "ja",
      log: "error",
      open: true,
      port: 8081,
      socket: path.resolve("mumble"),
      verbose: true,
      version: true,
      "bind-addr": "192.169.0.1:8080",
    })
  })

  it("should work with short options", async () => {
    expect(parse(["-vvv", "-v"])).toEqual({
      verbose: true,
      version: true,
    })
  })

  it("should use log level env var", async () => {
    const args = parse([])
    expect(args).toEqual({})

    process.env.LOG_LEVEL = "debug"
    const defaults = await setDefaults(args)
    expect(defaults).toStrictEqual({
      ...defaults,
      log: "debug",
      verbose: false,
    })
    expect(process.env.LOG_LEVEL).toEqual("debug")
    expect(logger.level).toEqual(Level.Debug)

    process.env.LOG_LEVEL = "trace"
    const updated = await setDefaults(args)
    expect(updated).toStrictEqual({
      ...updated,
      log: "trace",
      verbose: true,
    })
    expect(process.env.LOG_LEVEL).toEqual("trace")
    expect(logger.level).toEqual(Level.Trace)
  })

  it("should prefer --log to env var and --verbose to --log", async () => {
    let args = parse(["--log", "info"])
    expect(args).toEqual({
      log: "info",
    })

    process.env.LOG_LEVEL = "debug"
    const defaults = await setDefaults(args)
    expect(defaults).toEqual({
      ...defaults,
      log: "info",
      verbose: false,
    })
    expect(process.env.LOG_LEVEL).toEqual("info")
    expect(logger.level).toEqual(Level.Info)

    process.env.LOG_LEVEL = "trace"
    const updated = await setDefaults(args)
    expect(updated).toEqual({
      ...defaults,
      log: "info",
      verbose: false,
    })
    expect(process.env.LOG_LEVEL).toEqual("info")
    expect(logger.level).toEqual(Level.Info)

    args = parse(["--log", "info", "--verbose"])
    expect(args).toEqual({
      log: "info",
      verbose: true,
    })

    process.env.LOG_LEVEL = "warn"
    const updatedAgain = await setDefaults(args)
    expect(updatedAgain).toEqual({
      ...defaults,
      log: "trace",
      verbose: true,
    })
    expect(process.env.LOG_LEVEL).toEqual("trace")
    expect(logger.level).toEqual(Level.Trace)
  })

  it("should ignore invalid log level env var", async () => {
    process.env.LOG_LEVEL = "bogus"
    const defaults = await setDefaults(parse([]))
    expect(defaults).toEqual({
      ...defaults,
    })
  })

  it("should error if value isn't provided", () => {
    expect(() => parse(["--auth"])).toThrowError(/--auth requires a value/)
    expect(() => parse(["--auth=", "--log=debug"])).toThrowError(/--auth requires a value/)
    expect(() => parse(["--auth", "--log"])).toThrowError(/--auth requires a value/)
    expect(() => parse(["--auth", "--invalid"])).toThrowError(/--auth requires a value/)
    expect(() => parse(["--bind-addr"])).toThrowError(/--bind-addr requires a value/)
  })

  it("should error if value is invalid", () => {
    expect(() => parse(["--port", "foo"])).toThrowError(/--port must be a number/)
    expect(() => parse(["--auth", "invalid"])).toThrowError(/--auth valid values: \[password, none\]/)
    expect(() => parse(["--log", "invalid"])).toThrowError(/--log valid values: \[trace, debug, info, warn, error\]/)
  })

  it("should error if the option doesn't exist", () => {
    expect(() => parse(["--foo"])).toThrowError(/Unknown option --foo/)
  })

  it("should not error if the value is optional", async () => {
    expect(parse(["--cert"])).toEqual({
      cert: {
        value: undefined,
      },
    })
  })

  it("should not allow option-like values", () => {
    expect(() => parse(["--socket", "--socket-path-value"])).toThrowError(/--socket requires a value/)
    // If you actually had a path like this you would do this instead:
    expect(parse(["--socket", "./--socket-path-value"])).toEqual({
      socket: path.resolve("--socket-path-value"),
    })
    expect(() => parse(["--cert", "--socket-path-value"])).toThrowError(/Unknown option --socket-path-value/)
  })

  it("should allow positional arguments before options", async () => {
    expect(parse(["test", "--auth", "none"])).toEqual({
      _: ["test"],
      auth: "none",
    })
  })

  it("should support repeatable flags", async () => {
    expect(parse(["--proxy-domain", "*.coder.com"])).toEqual({
      "proxy-domain": ["*.coder.com"],
    })
    expect(parse(["--proxy-domain", "*.coder.com", "--proxy-domain", "test.com"])).toEqual({
      "proxy-domain": ["*.coder.com", "test.com"],
    })
  })

  it("should enforce cert-key with cert value or otherwise generate one", async () => {
    const args = parse(["--cert"])
    expect(args).toEqual({
      cert: {
        value: undefined,
      },
    })
    expect(() => parse(["--cert", "test"])).toThrowError(/--cert-key is missing/)
    const defaultArgs = await setDefaults(args)
    expect(defaultArgs).toEqual({
      ...defaults,
      cert: {
        value: path.join(paths.data, "localhost.crt"),
      },
      "cert-key": path.join(paths.data, "localhost.key"),
    })
  })

  it("should override with --link", async () => {
    const args = parse("--cert test --cert-key test --socket test --host 0.0.0.0 --port 8888 --link test".split(" "))
    const defaultArgs = await setDefaults(args)
    expect(defaultArgs).toEqual({
      ...defaults,
      auth: "none",
      host: "localhost",
      link: {
        value: "test",
      },
      port: 0,
      cert: undefined,
      "cert-key": path.resolve("test"),
      socket: undefined,
    })
  })

  it("should use env var password", async () => {
    process.env.PASSWORD = "test"
    const args = parse([])
    expect(args).toEqual({})

    const defaultArgs = await setDefaults(args)
    expect(defaultArgs).toEqual({
      ...defaults,
      password: "test",
      usingEnvPassword: true,
    })
  })

  it("should use env var hashed password", async () => {
    process.env.HASHED_PASSWORD =
      "$argon2i$v=19$m=4096,t=3,p=1$0qR/o+0t00hsbJFQCKSfdQ$oFcM4rL6o+B7oxpuA4qlXubypbBPsf+8L531U7P9HYY" // test
    const args = parse([])
    expect(args).toEqual({})

    const defaultArgs = await setDefaults(args)
    expect(defaultArgs).toEqual({
      ...defaults,
      "hashed-password":
        "$argon2i$v=19$m=4096,t=3,p=1$0qR/o+0t00hsbJFQCKSfdQ$oFcM4rL6o+B7oxpuA4qlXubypbBPsf+8L531U7P9HYY",
      usingEnvHashedPassword: true,
    })
  })

  it("should error if password passed in", () => {
    expect(() => parse(["--password", "supersecret123"])).toThrowError(
      "--password can only be set in the config file or passed in via $PASSWORD",
    )
  })

  it("should error if hashed-password passed in", () => {
    expect(() => parse(["--hashed-password", "fdas423fs8a"])).toThrowError(
      "--hashed-password can only be set in the config file or passed in via $HASHED_PASSWORD",
    )
  })

  it("should filter proxy domains", async () => {
    const args = parse(["--proxy-domain", "*.coder.com", "--proxy-domain", "coder.com", "--proxy-domain", "coder.org"])
    expect(args).toEqual({
      "proxy-domain": ["*.coder.com", "coder.com", "coder.org"],
    })

    const defaultArgs = await setDefaults(args)
    expect(defaultArgs).toEqual({
      ...defaults,
      "proxy-domain": ["coder.com", "coder.org"],
    })
  })
  it("should allow '=,$/' in strings", async () => {
    const args = parse([
      "--disable-update-check",
      "$argon2i$v=19$m=4096,t=3,p=1$0qr/o+0t00hsbjfqcksfdq$ofcm4rl6o+b7oxpua4qlxubypbbpsf+8l531u7p9hyy",
    ])
    expect(args).toEqual({
      "disable-update-check": true,
      _: ["$argon2i$v=19$m=4096,t=3,p=1$0qr/o+0t00hsbjfqcksfdq$ofcm4rl6o+b7oxpua4qlxubypbbpsf+8l531u7p9hyy"],
    })
  })
  it("should parse options with double-dash and multiple equal signs ", async () => {
    const args = parse(
      [
        "--hashed-password=$argon2i$v=19$m=4096,t=3,p=1$0qr/o+0t00hsbjfqcksfdq$ofcm4rl6o+b7oxpua4qlxubypbbpsf+8l531u7p9hyy",
      ],
      {
        configFile: "/pathtoconfig",
      },
    )
    expect(args).toEqual({
      "hashed-password":
        "$argon2i$v=19$m=4096,t=3,p=1$0qr/o+0t00hsbjfqcksfdq$ofcm4rl6o+b7oxpua4qlxubypbbpsf+8l531u7p9hyy",
    })
  })
})

describe("cli", () => {
  const testName = "cli"
  const vscodeIpcPath = path.join(os.tmpdir(), "vscode-ipc")

  beforeAll(async () => {
    await clean(testName)
  })

  beforeEach(async () => {
    delete process.env.VSCODE_IPC_HOOK_CLI
    await fs.rmdir(vscodeIpcPath, { recursive: true })
  })

  it("should use existing if inside code-server", async () => {
    process.env.VSCODE_IPC_HOOK_CLI = "test"
    const args: UserProvidedArgs = {}
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual("test")

    args.port = 8081
    args._ = ["./file"]
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual("test")
  })

  it("should use existing if --reuse-window is set", async () => {
    const args: UserProvidedArgs = {}
    args["reuse-window"] = true
    await expect(shouldOpenInExistingInstance(args)).resolves.toStrictEqual(undefined)

    await fs.writeFile(vscodeIpcPath, "test")
    await expect(shouldOpenInExistingInstance(args)).resolves.toStrictEqual("test")

    args.port = 8081
    await expect(shouldOpenInExistingInstance(args)).resolves.toStrictEqual("test")
  })

  it("should use existing if --new-window is set", async () => {
    const args: UserProvidedArgs = {}
    args["new-window"] = true
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual(undefined)

    await fs.writeFile(vscodeIpcPath, "test")
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual("test")

    args.port = 8081
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual("test")
  })

  it("should use existing if no unrelated flags are set, has positional, and socket is active", async () => {
    const args: UserProvidedArgs = {}
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual(undefined)

    args._ = ["./file"]
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual(undefined)

    const testDir = await tmpdir(testName)
    const socketPath = path.join(testDir, "socket")
    await fs.writeFile(vscodeIpcPath, socketPath)
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual(undefined)

    await new Promise((resolve) => {
      const server = net.createServer(() => {
        // Close after getting the first connection.
        server.close()
      })
      server.once("listening", () => resolve(server))
      server.listen(socketPath)
    })

    expect(await shouldOpenInExistingInstance(args)).toStrictEqual(socketPath)

    args.port = 8081
    expect(await shouldOpenInExistingInstance(args)).toStrictEqual(undefined)
  })
})

describe("splitOnFirstEquals", () => {
  it("should split on the first equals", () => {
    const testStr = "enabled-proposed-api=test=value"
    const actual = splitOnFirstEquals(testStr)
    const expected = ["enabled-proposed-api", "test=value"]
    expect(actual).toEqual(expect.arrayContaining(expected))
  })
  it("should split on first equals regardless of multiple equals signs", () => {
    const testStr =
      "hashed-password=$argon2i$v=19$m=4096,t=3,p=1$0qR/o+0t00hsbJFQCKSfdQ$oFcM4rL6o+B7oxpuA4qlXubypbBPsf+8L531U7P9HYY"
    const actual = splitOnFirstEquals(testStr)
    const expected = [
      "hashed-password",
      "$argon2i$v=19$m=4096,t=3,p=1$0qR/o+0t00hsbJFQCKSfdQ$oFcM4rL6o+B7oxpuA4qlXubypbBPsf+8L531U7P9HYY",
    ]
    expect(actual).toEqual(expect.arrayContaining(expected))
  })
  it("should always return the first element before an equals", () => {
    const testStr = "auth="
    const actual = splitOnFirstEquals(testStr)
    const expected = ["auth"]
    expect(actual).toEqual(expect.arrayContaining(expected))
  })
})

describe("shouldSpawnCliProcess", () => {
  it("should return false if no 'extension' related args passed in", async () => {
    const args = {}
    const actual = await shouldSpawnCliProcess(args)
    const expected = false

    expect(actual).toBe(expected)
  })

  it("should return true if 'list-extensions' passed in", async () => {
    const args = {
      ["list-extensions"]: true,
    }
    const actual = await shouldSpawnCliProcess(args)
    const expected = true

    expect(actual).toBe(expected)
  })

  it("should return true if 'install-extension' passed in", async () => {
    const args = {
      ["install-extension"]: ["hello.world"],
    }
    const actual = await shouldSpawnCliProcess(args)
    const expected = true

    expect(actual).toBe(expected)
  })

  it("should return true if 'uninstall-extension' passed in", async () => {
    const args: UserProvidedArgs = {
      ["uninstall-extension"]: ["hello.world"],
    }
    const actual = await shouldSpawnCliProcess(args)
    const expected = true

    expect(actual).toBe(expected)
  })
})

describe("bindAddrFromArgs", () => {
  it("should return the bind address", () => {
    const args: UserProvidedArgs = {}

    const addr = {
      host: "localhost",
      port: 8080,
    }

    const actual = bindAddrFromArgs(addr, args)
    const expected = addr

    expect(actual).toStrictEqual(expected)
  })

  it("should use the bind-address if set in args", () => {
    const args: UserProvidedArgs = {
      ["bind-addr"]: "localhost:3000",
    }

    const addr = {
      host: "localhost",
      port: 8080,
    }

    const actual = bindAddrFromArgs(addr, args)
    const expected = {
      host: "localhost",
      port: 3000,
    }

    expect(actual).toStrictEqual(expected)
  })

  it("should use the host if set in args", () => {
    const args: UserProvidedArgs = {
      ["host"]: "coder",
    }

    const addr = {
      host: "localhost",
      port: 8080,
    }

    const actual = bindAddrFromArgs(addr, args)
    const expected = {
      host: "coder",
      port: 8080,
    }

    expect(actual).toStrictEqual(expected)
  })

  it("should use process.env.PORT if set", () => {
    const [setValue, resetValue] = useEnv("PORT")
    setValue("8000")

    const args: UserProvidedArgs = {}

    const addr = {
      host: "localhost",
      port: 8080,
    }

    const actual = bindAddrFromArgs(addr, args)
    const expected = {
      host: "localhost",
      port: 8000,
    }

    expect(actual).toStrictEqual(expected)
    resetValue()
  })

  it("should set port if in args", () => {
    const args: UserProvidedArgs = {
      port: 3000,
    }

    const addr = {
      host: "localhost",
      port: 8080,
    }

    const actual = bindAddrFromArgs(addr, args)
    const expected = {
      host: "localhost",
      port: 3000,
    }

    expect(actual).toStrictEqual(expected)
  })

  it("should use the args.port over process.env.PORT if both set", () => {
    const [setValue, resetValue] = useEnv("PORT")
    setValue("8000")

    const args: UserProvidedArgs = {
      port: 3000,
    }

    const addr = {
      host: "localhost",
      port: 8080,
    }

    const actual = bindAddrFromArgs(addr, args)
    const expected = {
      host: "localhost",
      port: 3000,
    }

    expect(actual).toStrictEqual(expected)
    resetValue()
  })
})

describe("defaultConfigFile", () => {
  it("should return the default config file as a string", async () => {
    const password = await generatePassword()
    const actual = defaultConfigFile(password)

    expect(actual).toMatch(`bind-addr: 127.0.0.1:8080
auth: password
password: ${password}
cert: false`)
  })
})

describe("readSocketPath", () => {
  const fileContents = "readSocketPath file contents"
  let tmpDirPath: string
  let tmpFilePath: string

  const testName = "readSocketPath"
  beforeAll(async () => {
    await clean(testName)
  })

  beforeEach(async () => {
    tmpDirPath = await tmpdir(testName)
    tmpFilePath = path.join(tmpDirPath, "readSocketPath.txt")
    await fs.writeFile(tmpFilePath, fileContents)
  })

  it("should throw an error if it can't read the file", async () => {
    // TODO@jsjoeio - implement
    // Test it on a directory.... ESDIR
    // TODO@jsjoeio - implement
    expect(() => readSocketPath(tmpDirPath)).rejects.toThrow("EISDIR")
  })
  it("should return undefined if it can't read the file", async () => {
    // TODO@jsjoeio - implement
    const socketPath = await readSocketPath(path.join(tmpDirPath, "not-a-file"))
    expect(socketPath).toBeUndefined()
  })
  it("should return the file contents", async () => {
    const contents = await readSocketPath(tmpFilePath)
    expect(contents).toBe(fileContents)
  })
  it("should return the same file contents for two different calls", async () => {
    const contents1 = await readSocketPath(tmpFilePath)
    const contents2 = await readSocketPath(tmpFilePath)
    expect(contents2).toBe(contents1)
  })
})

describe("toVsCodeArgs", () => {
  const vscodeDefaults = {
    ...defaults,
    "connection-token": "0000",
    "accept-server-license-terms": true,
    help: false,
    port: "8080",
    version: false,
  }

  const testName = "vscode-args"
  beforeAll(async () => {
    // Clean up temporary directories from the previous run.
    await clean(testName)
  })

  it("should convert empty args", async () => {
    expect(await toVsCodeArgs(await setDefaults(parse([])))).toStrictEqual({
      ...vscodeDefaults,
      folder: "",
      workspace: "",
    })
  })

  it("should convert with workspace", async () => {
    const workspace = path.join(await tmpdir(testName), "test.code-workspace")
    await fs.writeFile(workspace, "foobar")
    expect(await toVsCodeArgs(await setDefaults(parse([workspace])))).toStrictEqual({
      ...vscodeDefaults,
      workspace,
      folder: "",
      _: [workspace],
    })
  })

  it("should convert with folder", async () => {
    const folder = await tmpdir(testName)
    expect(await toVsCodeArgs(await setDefaults(parse([folder])))).toStrictEqual({
      ...vscodeDefaults,
      folder,
      workspace: "",
      _: [folder],
    })
  })

  it("should ignore regular file", async () => {
    const file = path.join(await tmpdir(testName), "file")
    await fs.writeFile(file, "foobar")
    expect(await toVsCodeArgs(await setDefaults(parse([file])))).toStrictEqual({
      ...vscodeDefaults,
      folder: "",
      workspace: "",
      _: [file],
    })
  })
})
