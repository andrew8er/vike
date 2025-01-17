export { getPageContextFromHooks_isHydration }
export { getPageContextFromHooks_isNotHydration }
export { getPageContextFromHooks_serialized }
export { isServerSideRouted }

import {
  assert,
  assertUsage,
  hasProp,
  objectAssign,
  getProjectError,
  serverSideRouteTo,
  executeHook,
  isObject,
  getGlobalObject
} from './utils.js'
import { parse } from '@brillout/json-serializer/parse'
import { getPageContextSerializedInHtml } from '../shared/getPageContextSerializedInHtml.js'
import type { PageContextExports, PageFile } from '../../shared/getPageFiles.js'
import { analyzePageServerSide } from '../../shared/getPageFiles/analyzePageServerSide.js'
import { getHook } from '../../shared/hooks/getHook.js'
import { preparePageContextForUserConsumptionClientSide } from '../shared/preparePageContextForUserConsumptionClientSide.js'
import { removeBuiltInOverrides } from './getPageContext/removeBuiltInOverrides.js'
import { getPageContextRequestUrl } from '../../shared/getPageContextRequestUrl.js'
import type { PageConfigRuntime } from '../../shared/page-configs/PageConfig.js'
import { getConfigValue, getPageConfig } from '../../shared/page-configs/helpers.js'
import { assertOnBeforeRenderHookReturn } from '../../shared/assertOnBeforeRenderHookReturn.js'
import { executeGuardHook } from '../../shared/route/executeGuardHook.js'
import { AbortRender, isAbortPageContext } from '../../shared/route/abort.js'
import { pageContextInitIsPassedToClient } from '../../shared/misc/pageContextInitIsPassedToClient.js'
import { isRenderFailure } from '../../shared/misc/isRenderFailure.js'
const globalObject = getGlobalObject<{ pageContextInitIsPassedToClient?: true }>('router/getPageContext.ts', {})

type PageContext = {
  urlOriginal: string
  _urlRewrite: string | null
  _pageFilesAll: PageFile[]
  _pageConfigs: PageConfigRuntime[]
}

type PageContextSerialized = {
  _pageId: string
  _hasPageContextFromServer: true
}
function getPageContextFromHooks_serialized(): PageContextSerialized {
  const pageContextSerialized = getPageContextSerializedInHtml()
  processPageContextFromServer(pageContextSerialized)
  objectAssign(pageContextSerialized, {
    _hasPageContextFromServer: true as const
  })
  return pageContextSerialized
}
async function getPageContextFromHooks_isHydration(
  pageContext: PageContextSerialized & PageContext & PageContextExports
) {
  const pageContextFromHooks = {
    isHydration: true as const,
    _hasPageContextFromClient: false as const,
    _hasPageContextFromServer: true as const
  }
  for (const hookName of ['data', 'onBeforeRender'] as const) {
    const pageContextForHook = { ...pageContext, ...pageContextFromHooks }
    if (hookClientOnlyExists(hookName, pageContextForHook)) {
      const pageContextFromHook = await executeHookClientSide(hookName, pageContextForHook)
      Object.assign(pageContextFromHooks, pageContextFromHook)
    }
  }
  return pageContextFromHooks
}

async function getPageContextFromHooks_isNotHydration(
  pageContext: { _pageId: string } & PageContext & PageContextExports,
  isErrorPage: boolean
) {
  const pageContextFromHooks = {
    isHydration: false as const,
    _hasPageContextFromClient: false
  }

  let hasPageContextFromServer = false
  // If pageContextInit has some client data or if one of the hooks guard(), data() or onBeforeRender() is server-side
  // only, then we need to fetch pageContext from the server.
  // We do it before executing any client-side hook, because it contains pageContextInit which may be needed for guard() / data() / onBeforeRender(), for example pageContextInit.user is crucial for guard()
  if (
    // For the error page, we cannot fetch pageContext from the server because the pageContext JSON request is based on the URL
    !isErrorPage &&
    // true if pageContextInit has some client data or at least one of the data() and onBeforeRender() hooks is server-side only:
    (await hasPageContextServer({ ...pageContext, ...pageContextFromHooks }))
  ) {
    const pageContextFromServer = await fetchPageContextFromServer(pageContext)
    hasPageContextFromServer = true
    if (!pageContextFromServer[isRenderFailure] || isErrorPage) {
      objectAssign(pageContextFromHooks, pageContextFromServer)
    } else {
      // When the user hasn't define a `_error.page.js` file: the mechanism with `serverSideError: true` is used instead
      assert(!('serverSideError' in pageContextFromServer))
      assert(hasProp(pageContextFromServer, 'is404', 'boolean'))
      assert(hasProp(pageContextFromServer, 'pageProps', 'object'))
      assert(hasProp(pageContextFromServer.pageProps, 'is404', 'boolean'))
      objectAssign(pageContextFromServer, {
        _hasPageContextFromServer: true as const,
        _hasPageContextFromClient: false as const
      })
      return pageContextFromServer
    }
  }

  // At this point, we need to call the client-side guard(), data() and onBeforeRender() hooks, if they exist on client
  // env. However if we have fetched pageContext from the server, some of them might have run already on the
  // server-side, so we run only the client-only ones in this case.
  // Note: for the error page, we also execute the client-side data() and onBeforeRender() hooks, but maybe we
  // shouldn't? The server-side does it as well (but maybe it shouldn't).
  for (const hookName of ['guard', 'data', 'onBeforeRender'] as const) {
    const pageContextForHook = {
      _hasPageContextFromServer: hasPageContextFromServer,
      ...pageContext,
      ...pageContextFromHooks
    }
    if (hookName === 'guard') {
      if (
        !isErrorPage &&
        // We don't need to call guard() on the client-side if we fetch pageContext from the server side. (Because the `${url}.pageContext.json` HTTP request will already trigger the routing and guard() hook on the server-side.)
        !hasPageContextFromServer
      ) {
        // Should we really call the guard() hook on the client-side? Shouldn't we make the guard() hook a server-side
        // only hook? Or maybe make its env configurable like data() and onBeforeRender()?
        await executeGuardHook(pageContextForHook, (pageContext) =>
          preparePageContextForUserConsumptionClientSide(pageContext, true)
        )
      }
    } else {
      assert(hookName === 'data' || hookName === 'onBeforeRender')
      if (hookClientOnlyExists(hookName, pageContextForHook) || !hasPageContextFromServer) {
        // This won't do anything if no hook has been defined or if the hook's env.client is false.
        const pageContextFromHook = await executeHookClientSide(hookName, pageContextForHook)
        objectAssign(pageContextFromHooks, pageContextFromHook)
      } else {
        assert(hasPageContextFromServer)
      }
    }
  }

  objectAssign(pageContextFromHooks, {
    _hasPageContextFromServer: hasPageContextFromServer
  })

  return pageContextFromHooks
}

async function executeHookClientSide(
  hookName: 'data' | 'onBeforeRender',
  pageContext: {
    _pageId: string
    _hasPageContextFromServer: boolean
    _hasPageContextFromClient: boolean
  } & PageContextExports &
    PageContext
) {
  const hook = getHook(pageContext, hookName)
  if (!hook) {
    // No hook defined or hook's env.client is false
    return null
  }
  const pageContextForUserConsumption = preparePageContextForUserConsumptionClientSide(pageContext, true)
  const hookResult = await executeHook(() => hook.hookFn(pageContextForUserConsumption), hook)

  const pageContextFromHook = {}
  if (hookName === 'onBeforeRender') {
    assertOnBeforeRenderHookReturn(hookResult, hook.hookFilePath)
    // Note: hookResult looks like { pageContext: { ... } }
    const pageContextFromOnBeforeRender = hookResult?.pageContext
    if (pageContextFromOnBeforeRender) {
      objectAssign(pageContextFromHook, { _hasPageContextFromClient: true })
      objectAssign(pageContextFromHook, pageContextFromOnBeforeRender)
    }
  } else {
    assert(hookName === 'data')
    // Note: hookResult can be anything (e.g. an object) and is to be assigned to pageContext.data
    const pageContextFromData = {
      data: hookResult
    }
    if (hookResult) {
      objectAssign(pageContextFromHook, { _hasPageContextFromClient: true })
    }
    objectAssign(pageContextFromHook, pageContextFromData)
  }
  return pageContextFromHook
}

// Workaround for the fact that the client-side cannot known whether a pageContext JSON request is needed in order to fetch pageContextInit data passed to the client.
//  - The workaround is reliable as long as the user sets additional pageContextInit to undefined instead of not defining the property:
//    ```diff
//    - // Breaks the workaround:
//    - const pageContextInit = { urlOriginal: req.url }
//    - if (user) pageContextInit.user = user
//    + // Makes the workaround reliable:
//    + const pageContextInit = { urlOriginal: req.url, user }
//    ```
// - We can show a warning to users when the pageContextInit keys aren't always the same. (We didn't implement the waning yet because it would require a new doc page https://vike.dev/pageContextInit#avoid-conditional-properties
// - Workaround cannot be made completely reliable because the workaround assumes that passToClient is always the same, but the user may set a different passToClient value for another page
// - Alternatively, we could define a new config `alwaysFetchPageContextFromServer: boolean`
function setPageContextInitIsPassedToClient(pageContext: Record<string, unknown>) {
  if (pageContext[pageContextInitIsPassedToClient]) {
    globalObject.pageContextInitIsPassedToClient = true
  }
}

// TODO/v1-release: make it sync
async function hasPageContextServer(pageContext: Parameters<typeof hookServerOnlyExists>[1]): Promise<boolean> {
  return (
    !!globalObject.pageContextInitIsPassedToClient ||
    (await hookServerOnlyExists('data', pageContext)) ||
    (await hookServerOnlyExists('onBeforeRender', pageContext))
  )
}

// TODO/v1-release: make it sync
/**
 * @param hookName
 * @param pageContext
 * @returns `true` if the given page has a `hookName` hook defined with a server-only env.
 */
async function hookServerOnlyExists(
  hookName: 'data' | 'onBeforeRender',
  pageContext: {
    _pageId: string
    _pageFilesAll: PageFile[]
    _pageConfigs: PageConfigRuntime[]
  }
): Promise<boolean> {
  if (pageContext._pageConfigs.length > 0) {
    // V1
    const pageConfig = getPageConfig(pageContext._pageId, pageContext._pageConfigs)
    const hookEnv = getConfigValue(pageConfig, `${hookName}Env`)?.value ?? {}
    assert(isObject(hookEnv))
    return !!hookEnv.server && !hookEnv.client
  } else {
    // TODO/v1-release: remove
    // V0.4

    // data() hooks didn't exist in the V0.4 design
    if (hookName === 'data') return false

    assert(hookName === 'onBeforeRender')
    const { hasOnBeforeRenderServerSideOnlyHook } = await analyzePageServerSide(
      pageContext._pageFilesAll,
      pageContext._pageId
    )
    return hasOnBeforeRenderServerSideOnlyHook
  }
}

/**
 * @param hookName
 * @param pageContext
 * @returns `true` if the given page has a `hookName` hook defined with a client-only env.
 */
function hookClientOnlyExists(
  hookName: 'data' | 'onBeforeRender',
  pageContext: {
    _pageId: string
    _pageConfigs: PageConfigRuntime[]
  }
): boolean {
  if (pageContext._pageConfigs.length > 0) {
    // V1
    const pageConfig = getPageConfig(pageContext._pageId, pageContext._pageConfigs)
    const hookEnv = getConfigValue(pageConfig, `${hookName}Env`)?.value ?? {}
    assert(isObject(hookEnv))
    return !!hookEnv.client && !hookEnv.server
  } else {
    // TODO/v1-release: remove
    // Client-only onBeforeRender() or data() hooks were never supported for the V0.4 design
    return false
  }
}

async function fetchPageContextFromServer(pageContext: { urlOriginal: string; _urlRewrite: string | null }) {
  const pageContextUrl = getPageContextRequestUrl(pageContext._urlRewrite ?? pageContext.urlOriginal)
  const response = await fetch(pageContextUrl)

  {
    const contentType = response.headers.get('content-type')
    const contentTypeCorrect = 'application/json'
    const isCorrect = contentType && contentType.includes(contentTypeCorrect)

    // Static hosts + page doesn't exist
    if (!isCorrect && response.status === 404) {
      serverSideRouteTo(pageContext.urlOriginal)
      throw ServerSideRouted()
    }

    assertUsage(
      isCorrect,
      `Wrong Content-Type for ${pageContextUrl}: it should be ${contentTypeCorrect} but it's ${contentType} instead. Make sure to properly use pageContext.httpResponse.headers, see https://vike.dev/renderPage`
    )
  }

  const responseText = await response.text()
  const pageContextFromServer: unknown = parse(responseText)
  assert(isObject(pageContextFromServer))

  if ('serverSideError' in pageContextFromServer) {
    throw getProjectError(
      `The pageContext object couldn't be fetched from the server as an error occurred on the server-side. Check your server logs.`
    )
  }

  if (isAbortPageContext(pageContextFromServer)) {
    throw AbortRender(pageContextFromServer)
  }

  assert(hasProp(pageContextFromServer, '_pageId', 'string'))
  processPageContextFromServer(pageContextFromServer)

  return pageContextFromServer
}

function processPageContextFromServer(pageContextFromServer: Record<string, unknown>) {
  setPageContextInitIsPassedToClient(pageContextFromServer)
  removeBuiltInOverrides(pageContextFromServer)
}

function isServerSideRouted(err: unknown): boolean {
  return isObject(err) && !!err._alreadyServerSideRouted
}
function ServerSideRouted() {
  const err = new Error("Page doesn't exist")
  Object.assign(err, { _alreadyServerSideRouted: true })
  return err
}
