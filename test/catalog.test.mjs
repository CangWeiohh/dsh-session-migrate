import assert from 'node:assert/strict'
import test from 'node:test'

function visibleCatalog(headers, archived, titles) {
  const unique = new Map()
  for (const header of headers) if (!unique.has(String(header.id))) unique.set(String(header.id), header)
  return [...unique.values()]
    .filter((header) => header.origin !== 'subagent' && !archived.has(String(header.id)))
    .map((header) => ({ id: String(header.id), title: titles[String(header.id)] || header.cwd?.split('/').pop() || String(header.id) }))
}

test('visible catalog deduplicates and matches Desktop visibility/title fallback', () => {
  const result = visibleCatalog([
    { id: 'a', cwd: '/work/Alpha' },
    { id: 'a', cwd: '/work/Alpha' },
    { id: 'b', cwd: '/work/Beta', origin: 'subagent' },
    { id: 'c', cwd: '/work/Gamma' },
    { id: 'd', cwd: '/work/Delta' },
  ], new Set(['c']), { a: '自定义标题' })
  assert.deepEqual(result, [{ id: 'a', title: '自定义标题' }, { id: 'd', title: 'Delta' }])
})
