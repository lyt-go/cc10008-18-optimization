import { existsSync } from 'node:fs'

const SRC = 'file:///workspace/frontend/src/'

export async function resolve(specifier, context, nextResolve) {
  // 1) '@/' 别名映射到 frontend/src
  if (specifier.startsWith('@/')) {
    const base = new URL(specifier.slice(2), SRC)
    const resolved = resolveTs(base)
    return nextResolve(resolved, context)
  }
  // 2) 相对路径的无扩展名 TS 导入（node ESM 不补扩展名）
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !hasKnownExtension(specifier)) {
    const parent = context.parentURL ? new URL(specifier, context.parentURL) : new URL(specifier)
    return nextResolve(resolveTs(parent), context)
  }
  return nextResolve(specifier, context)
}

function resolveTs(url) {
  if (hasKnownExtension(url.pathname)) {
    return url.href
  }
  const candidates = [url.href + '.ts', url.href + '/index.ts']
  for (const candidate of candidates) {
    if (existsSync(new URL(candidate))) {
      return candidate
    }
  }
  return url.href
}

function hasKnownExtension(pathname) {
  return /\.[a-zA-Z0-9]+$/.test(pathname)
}
