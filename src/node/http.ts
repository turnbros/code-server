import { field, logger } from "@coder/logger"
import * as express from "express"
import { RequestContext } from "express-openid-connect"
import * as expressCore from "express-serve-static-core"
import * as http from "http"
import * as net from "net"
import * as qs from "qs"
import { Disposable } from "../common/emitter"
import { CookieKeys, HttpCode, HttpError } from "../common/http"
import { normalize } from "../common/util"
import { AuthType, DefaultedArgs } from "./cli"
import { version as codeServerVersion } from "./constants"
import { Heart } from "./heart"
import { CoderSettings, SettingsProvider } from "./settings"
import { UpdateProvider } from "./update"
import { getPasswordMethod, IsCookieValidArgs, isCookieValid, sanitizeString, escapeHtml, escapeJSON } from "./util"

/**
 * Base options included on every page.
 */
export interface ClientConfiguration {
  codeServerVersion: string
  /** Relative path from this page to the root.  No trailing slash. */
  base: string
  /** Relative path from this page to the static root.  No trailing slash. */
  csStaticBase: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    export interface Request {
      args: DefaultedArgs
      heart: Heart
      oidc: RequestContext
      settings: SettingsProvider<CoderSettings>
      updater: UpdateProvider
    }
  }
}

export const createClientConfiguration = (req: express.Request): ClientConfiguration => {
  const base = relativeRoot(req.originalUrl)

  return {
    base,
    csStaticBase: base + "/_static",
    codeServerVersion,
  }
}

/**
 * Replace common variable strings in HTML templates.
 */
export const replaceTemplates = <T extends object>(
  req: express.Request,
  content: string,
  extraOpts?: Omit<T, "base" | "csStaticBase" | "logLevel">,
): string => {
  const serverOptions: ClientConfiguration = {
    ...createClientConfiguration(req),
    ...extraOpts,
  }

  return content
    .replace(/{{TO}}/g, (typeof req.query.to === "string" && escapeHtml(req.query.to)) || "/")
    .replace(/{{BASE}}/g, serverOptions.base)
    .replace(/{{CS_STATIC_BASE}}/g, serverOptions.csStaticBase)
    .replace("{{OPTIONS}}", () => escapeJSON(serverOptions))
}

/**
 * Throw an error if not authorized. Call `next` if provided.
 */
export const ensureAuthenticated = async (
  req: express.Request,
  _?: express.Response,
  next?: express.NextFunction,
): Promise<void> => {
  const isAuthenticated = await authenticated(req)
  if (!isAuthenticated) {
    throw new HttpError("Unauthorized", HttpCode.Unauthorized)
  }
  if (next) {
    next()
  }
}

/**
 * Return true if authenticated via cookies.
 */
export const authenticated = async (req: express.Request): Promise<boolean> => {
  switch (req.args.auth) {
    // NO authentication used...
    case AuthType.None: {
      return true
    }

    // BASIC authentication used...
    case AuthType.Password: {
      // The password is stored in the cookie after being hashed.
      const hashedPasswordFromArgs = req.args["hashed-password"]
      const passwordMethod = getPasswordMethod(hashedPasswordFromArgs)
      const isCookieValidArgs: IsCookieValidArgs = {
        passwordMethod,
        cookieKey: sanitizeString(req.cookies[CookieKeys.Session]),
        passwordFromArgs: req.args.password || "",
        hashedPasswordFromArgs: req.args["hashed-password"],
      }

      return await isCookieValid(isCookieValidArgs)
    }

    // OiDC authentication used...
    case AuthType.Openid: {
      if (req.oidc.isAuthenticated()) {
        logger.debug("User authenticated with OpenID Connect", field("user", req.oidc.user))

        // Check to see if a group claim was specified.
        // If there was no group claim specified the user will be considered authorized.
        if (!req.args["openid-group-claim"]) {
          return true
        }

        // With the user authenticated we need to check the group claims to make sure they're authorized.
        for (const key in req.oidc.idTokenClaims) {
          const claims = <string[]>req.oidc.idTokenClaims[key]
          if (key === req.args["openid-group-claim"] && req.args["openid-group-claim"].value) {
            for (const value in claims) {
              if (req.args["openid-user-group"] === claims[value]) {
                logger.debug("User authorized", field("user", req.oidc.user))
                return true
              }
            }
          }
        }

        // Throw an error informing the user that they're unauthorized.
        logger.debug("User not authorized", field("user", req.oidc.user))
        throw new HttpError("Unauthorized", HttpCode.Unauthorized)
      }

      // Returning false means the user isn't authenticated.
      // This should trigger a redirect so the user can get authenticated.
      logger.debug("User not authenticated using OpenID Connect", field("user", req.oidc.user))
      return false
    }
    default: {
      throw new Error(`Unsupported auth type ${req.args.auth}`)
    }
  }
}

/**
 * Get the relative path that will get us to the root of the page. For each
 * slash we need to go up a directory.  Will not have a trailing slash.
 *
 * For example:
 *
 * / => .
 * /foo => .
 * /foo/ => ./..
 * /foo/bar => ./..
 * /foo/bar/ => ./../..
 *
 * All paths must be relative in order to work behind a reverse proxy since we
 * we do not know the base path.  Anything that needs to be absolute (for
 * example cookies) must get the base path from the frontend.
 *
 * All relative paths must be prefixed with the relative root to ensure they
 * work no matter the depth at which they happen to appear.
 *
 * For Express `req.originalUrl` should be used as they remove the base from the
 * standard `url` property making it impossible to get the true depth.
 */
export const relativeRoot = (originalUrl: string): string => {
  const depth = (originalUrl.split("?", 1)[0].match(/\//g) || []).length
  return normalize("./" + (depth > 1 ? "../".repeat(depth - 1) : ""))
}

/**
 * Redirect relatively to `/${to}`. Query variables on the current URI will be
 * preserved.  `to` should be a simple path without any query parameters
 * `override` will merge with the existing query (use `undefined` to unset).
 */
export const redirect = (
  req: express.Request,
  res: express.Response,
  to: string,
  override: expressCore.Query = {},
): void => {
  const query = Object.assign({}, req.query, override)
  Object.keys(override).forEach((key) => {
    if (typeof override[key] === "undefined") {
      delete query[key]
    }
  })

  const relativePath = normalize(`${relativeRoot(req.originalUrl)}/${to}`, true)
  const queryString = qs.stringify(query)
  const redirectPath = `${relativePath}${queryString ? `?${queryString}` : ""}`
  logger.debug(`redirecting from ${req.originalUrl} to ${redirectPath}`)
  res.redirect(redirectPath)
}

/**
 * Get the value that should be used for setting a cookie domain. This will
 * allow the user to authenticate once no matter what sub-domain they use to log
 * in. This will use the highest level proxy domain (e.g. `coder.com` over
 * `test.coder.com` if both are specified).
 */
export const getCookieDomain = (host: string, proxyDomains: string[]): string | undefined => {
  const idx = host.lastIndexOf(":")
  host = idx !== -1 ? host.substring(0, idx) : host
  // If any of these are true we will still set cookies but without an explicit
  // `Domain` attribute on the cookie.
  if (
    // The host can be be blank or missing so there's nothing we can set.
    !host ||
    // IP addresses can't have subdomains so there's no value in setting the
    // domain for them. Assume that anything with a : is ipv6 (valid domain name
    // characters are alphanumeric or dashes)...
    host.includes(":") ||
    // ...and that anything entirely numbers and dots is ipv4 (currently tlds
    // cannot be entirely numbers).
    !/[^0-9.]/.test(host) ||
    // localhost subdomains don't seem to work at all (browser bug?). A cookie
    // set at dev.localhost cannot be read by 8080.dev.localhost.
    host.endsWith(".localhost") ||
    // Domains without at least one dot (technically two since domain.tld will
    // become .domain.tld) are considered invalid according to the spec so don't
    // set the domain for them. In my testing though localhost is the only
    // problem (the browser just doesn't store the cookie at all). localhost has
    // an additional problem which is that a reverse proxy might give
    // code-server localhost even though the domain is really domain.tld (by
    // default NGINX does this).
    !host.includes(".")
  ) {
    logger.debug("no valid cookie doman", field("host", host))
    return undefined
  }

  proxyDomains.forEach((domain) => {
    if (host.endsWith(domain) && domain.length < host.length) {
      host = domain
    }
  })

  logger.debug("got cookie doman", field("host", host))
  return host || undefined
}

/**
 * Return a function capable of fully disposing an HTTP server.
 */
export function disposer(server: http.Server): Disposable["dispose"] {
  const sockets = new Set<net.Socket>()
  let cleanupTimeout: undefined | NodeJS.Timeout

  server.on("connection", (socket) => {
    sockets.add(socket)

    socket.on("close", () => {
      sockets.delete(socket)

      if (cleanupTimeout && sockets.size === 0) {
        clearTimeout(cleanupTimeout)
        cleanupTimeout = undefined
      }
    })
  })

  return () => {
    return new Promise<void>((resolve, reject) => {
      // The whole reason we need this disposer is because close will not
      // actually close anything; it only prevents future connections then waits
      // until everything is closed.
      server.close((err) => {
        if (err) {
          return reject(err)
        }

        resolve()
      })

      // If there are sockets remaining we might need to force close them or
      // this promise might never resolve.
      if (sockets.size > 0) {
        // Give sockets a chance to close up shop.
        cleanupTimeout = setTimeout(() => {
          cleanupTimeout = undefined

          for (const socket of sockets.values()) {
            console.warn("a socket was left hanging")
            socket.destroy()
          }
        }, 1000)
      }
    })
  }
}

/**
 * Get the options for setting a cookie.  The options must be identical for
 * setting and unsetting cookies otherwise they are considered separate.
 */
export const getCookieOptions = (req: express.Request): express.CookieOptions => {
  // Normally we set paths relatively.  However browsers do not appear to allow
  // cookies to be set relatively which means we need an absolute path.  We
  // cannot be guaranteed we know the path since a reverse proxy might have
  // rewritten it.  That means we need to get the path from the frontend.

  // The reason we need to set the path (as opposed to defaulting to /) is to
  // avoid code-server instances on different sub-paths clobbering each other or
  // from accessing each other's tokens (and to prevent other services from
  // accessing code-server's tokens).

  // When logging in or out the request must include the href (the full current
  // URL of that page) and the relative path to the root as given to it by the
  // backend.  Using these two we can determine the true absolute root.
  const url = new URL(
    req.query.base || req.body.base || "/",
    req.query.href || req.body.href || "http://" + (req.headers.host || "localhost"),
  )
  return {
    domain: getCookieDomain(url.host, req.args["proxy-domain"]),
    path: normalize(url.pathname) || "/",
    sameSite: "lax",
  }
}

/**
 * Return the full path to the current page, preserving any trailing slash.
 */
export const self = (req: express.Request): string => {
  return normalize(`${req.baseUrl}${req.originalUrl.endsWith("/") ? "/" : ""}`, true)
}
