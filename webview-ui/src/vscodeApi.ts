interface HostApi {
  postMessage(msg: unknown): void
}

declare global {
  interface Window {
    pixelAgentsHost?: HostApi
  }
}

declare const acquireVsCodeApi: undefined | (() => HostApi)

function resolveHostApi(): HostApi {
  if (typeof acquireVsCodeApi === 'function') {
    return acquireVsCodeApi()
  }
  if (window.pixelAgentsHost) {
    return window.pixelAgentsHost
  }
  return {
    postMessage(msg: unknown) {
      console.warn('No Pixel Agents host available for message', msg)
    },
  }
}

export const vscode = resolveHostApi()
