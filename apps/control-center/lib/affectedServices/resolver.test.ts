import assert from 'node:assert/strict'
import test from 'node:test'
import type { DependencyGraph, ServiceDependencyInfo } from '../github/w4sGraph'
import { resolveAffectedServices, type ResolverCompareInput } from './resolver'

// ---- Fixture graph — mirrors the REAL closures verified against
// nguyenvuhoang/w4s (commit 1c3ca549e6259a32bfadf9014c53cd36dcff575d) during
// the Chat 06 monorepo survey, trimmed to what the resolver needs. ----

const SHARED_PROPS = ['O24OpenAPI/Directory.Packages.props', 'O24OpenAPI/Directory.Build.props']

function simpleService(code: ServiceDependencyInfo['service']): ServiceDependencyInfo {
  const ownDir = `O24OpenAPI/O24OpenAPI.${code === 'LOG' ? 'Logger' : code}`
  return {
    service: code,
    dockerfile: `O24OpenAPI/O24OpenAPI.${code === 'LOG' ? 'Logger' : code}/X.API/Dockerfile`,
    image: `vknighthub/ips_o24${code.toLowerCase()}`,
    rootCsproj: `${ownDir}/X.API/X.API.csproj`,
    ownDir,
    projects: [`${ownDir}/X.API/X.API.csproj`, `${ownDir}/X.Domain/X.Domain.csproj`, `${ownDir}/X.Infrastructure/X.Infrastructure.csproj`, 'O24OpenAPI/O24OpenAPI.APIContracts/O24OpenAPI.APIContracts.csproj', 'O24OpenAPI/O24OpenAPI.GrpcContracts/O24OpenAPI.GrpcContracts.csproj'],
    dirs: [ownDir, 'O24OpenAPI/O24OpenAPI.APIContracts', 'O24OpenAPI/O24OpenAPI.GrpcContracts'],
    sharedPropsFiles: SHARED_PROPS,
  }
}

function fixtureGraph(): DependencyGraph {
  const wfoOwnDir = 'O24OpenAPI/O24OpenAPI.WFO'
  const wfo: ServiceDependencyInfo = {
    ...simpleService('WFO'),
    dirs: [wfoOwnDir, 'O24OpenAPI/O24OpenAPI.APIContracts', 'O24OpenAPI/O24OpenAPI.GrpcContracts', 'O24OpenAPI/O24OpenAPI.OData/src/O24OpenAPI.OData'],
  }
  return {
    ref: 'developer',
    services: {
      CMS: simpleService('CMS'),
      WFO: wfo,
      IPS: simpleService('IPS'),
      CTH: simpleService('CTH'),
      NCH: simpleService('NCH'),
      RPT: simpleService('RPT'),
      LOG: simpleService('LOG'),
    },
    missingServices: [],
    // Real, verified: modules that exist in O24OpenAPI.sln but are referenced by none of the 7 buildable services.
    knownUnrelatedDirs: ['O24OpenAPI/O24OpenAPI.ACT', 'O24OpenAPI/O24OpenAPI.AI', 'O24OpenAPI/O24OpenAPI.BUZ', 'O24OpenAPI/O24OpenAPI.DWH', 'O24OpenAPI/O24OpenAPI.Design', 'O24OpenAPI/O24OpenAPI.EXT', 'O24OpenAPI/O24OpenAPI.PMT', 'O24OpenAPI/O24OpenAPI.Sample', 'O24OpenAPI/O24OpenAPI.W4S'],
    solutionRoot: 'O24OpenAPI',
  }
}

const ALL_SERVICES = ['CMS', 'WFO', 'IPS', 'CTH', 'NCH', 'RPT', 'LOG']

function compareWith(files: ResolverCompareInput['files']): ResolverCompareInput {
  return { base: 'developer~1', head: 'developer', baseSha: 'base-sha', headSha: 'head-sha', status: 'ahead', files, truncated: false }
}

// 1. Chỉ đổi source CMS
test('only CMS source changed -> only CMS affected', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.CMS/X.Domain/Foo.cs', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices, ['CMS'])
  assert.equal(result.fellBackToAll, false)
  assert.ok(result.reasons.CMS?.[0].includes('Thay đổi trực tiếp'))
})

// 2. Chỉ đổi source WFO
test('only WFO source changed -> only WFO affected', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.WFO/X.API/Program.cs', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices, ['WFO'])
  assert.equal(result.fellBackToAll, false)
})

// 3. Đổi nhiều service
test('changes under two different services\' own dirs -> both affected, nothing else', () => {
  const result = resolveAffectedServices(
    compareWith([
      { filename: 'O24OpenAPI/O24OpenAPI.CMS/X.API/Controller.cs', status: 'modified' },
      { filename: 'O24OpenAPI/O24OpenAPI.NCH/X.Domain/Entity.cs', status: 'modified' },
    ]),
    fixtureGraph(),
  )
  assert.deepEqual(result.affectedServices.sort(), ['CMS', 'NCH'])
  assert.equal(result.fellBackToAll, false)
})

// 4. Đổi APIContracts -> tất cả
test('APIContracts change affects all 7 services', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.APIContracts/Dto/Foo.cs', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices.sort(), [...ALL_SERVICES].sort())
  assert.equal(result.fellBackToAll, false) // this is a REAL shared-dependency match, not a safety fallback
  assert.ok(result.reasons.CMS?.some((r) => r.includes('APIContracts')))
})

// 5. Đổi GrpcContracts (bao gồm Protos) -> tất cả
test('GrpcContracts change (including a nested Protos file) affects all 7 services', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.GrpcContracts/Protos/BUZ/buz.proto', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices.sort(), [...ALL_SERVICES].sort())
  assert.equal(result.fellBackToAll, false)
})

// 6. Đổi Directory.Packages.props -> tất cả
test('Directory.Packages.props (O24OpenAPI/ level, copied by every service) affects all 7 services', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/Directory.Packages.props', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices.sort(), [...ALL_SERVICES].sort())
  assert.equal(result.fellBackToAll, false)
})

// 7. Đổi Directory.Build.props: cấp O24OpenAPI/ -> tất cả; cấp root -> không ảnh hưởng
test('Directory.Build.props at O24OpenAPI/ level affects all 7 services', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/Directory.Build.props', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices.sort(), [...ALL_SERVICES].sort())
  assert.equal(result.fellBackToAll, false)
})

test('root-level Directory.Build.props (not copied by any Dockerfile) has no impact', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'Directory.Build.props', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices, [])
  assert.equal(result.fellBackToAll, false)
  assert.equal(result.matchedRules[0].rule, 'known-unrelated')
})

// 8. File docs không ảnh hưởng build
test('a docs file outside the solution folder has no impact and does not trigger fallback', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'README.md', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices, [])
  assert.equal(result.fellBackToAll, false)
  assert.equal(result.matchedRules[0].rule, 'known-unrelated')
})

test('a change in a known-but-unreferenced w4s module (e.g. ACT) has no impact', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.ACT/X.API/Controller.cs', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices, [])
  assert.equal(result.fellBackToAll, false)
  assert.equal(result.matchedRules[0].rule, 'known-unrelated')
})

// 9. File lạ không khớp rule nào -> fallback build tất cả + warning
test('an unrecognized file inside the solution folder falls back to building everything, with a warning', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.BrandNewModule/Foo.cs', status: 'added' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices.sort(), [...ALL_SERVICES].sort())
  assert.equal(result.fellBackToAll, true)
  assert.ok(result.warnings.length > 0)
})

test('a build-o24.yml change is unknown scope and falls back to building everything', () => {
  const result = resolveAffectedServices(compareWith([{ filename: '.github/workflows/build-o24.yml', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices.sort(), [...ALL_SERVICES].sort())
  assert.equal(result.fellBackToAll, true)
})

test('a graph fetch failure (graph is null) falls back to building everything', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.CMS/X.API/Controller.cs', status: 'modified' }]), null)
  assert.deepEqual(result.affectedServices.sort(), [...ALL_SERVICES].sort())
  assert.equal(result.fellBackToAll, true)
  assert.ok(result.warnings.some((w) => w.includes('dependency graph')))
})

test('a truncated compare (>= 300 files) falls back to building everything even if every file classified cleanly', () => {
  const result = resolveAffectedServices(
    { ...compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.CMS/X.API/Controller.cs', status: 'modified' }]), truncated: true },
    fixtureGraph(),
  )
  assert.deepEqual(result.affectedServices.sort(), [...ALL_SERVICES].sort())
  assert.equal(result.fellBackToAll, true)
})

// 10. Renamed/deleted file
test('a renamed file is classified by BOTH its new and previous path', () => {
  const result = resolveAffectedServices(
    compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.RPT/X.API/NewName.cs', status: 'renamed', previousFilename: 'O24OpenAPI/O24OpenAPI.NCH/X.API/OldName.cs' }]),
    fixtureGraph(),
  )
  assert.deepEqual(result.affectedServices.sort(), ['NCH', 'RPT'])
  assert.equal(result.fellBackToAll, false)
})

test('a deleted file is still classified by its (now-gone) path', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.IPS/X.Domain/Removed.cs', status: 'removed' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices, ['IPS'])
  assert.equal(result.fellBackToAll, false)
})

// 11. Compare không có thay đổi
test('an empty file list (identical compare) affects nothing and never falls back', () => {
  const result = resolveAffectedServices({ ...compareWith([]), status: 'identical' }, fixtureGraph())
  assert.deepEqual(result.affectedServices, [])
  assert.equal(result.fellBackToAll, false)
  assert.equal(result.warnings.length, 0)
})

// 12. Case-sensitive path matching (GitHub compare paths are always POSIX, always exact-case)
test('path matching is exact-case — a differently-cased path does not spuriously match a real project dir', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'o24openapi/o24openapi.cms/x.api/controller.cs', status: 'modified' }]), fixtureGraph())
  // Doesn't match the (correctly-cased) solutionRoot prefix either, so this
  // is classified as outside the solution folder — not a CMS match, and
  // specifically NOT a silent no-op: it's still reported, just as no-impact.
  assert.deepEqual(result.affectedServices, [])
  assert.equal(result.matchedRules[0].rule, 'known-unrelated')
})

test('WFO-only shared dependency (OData) affects only WFO, not the other 6 services', () => {
  const result = resolveAffectedServices(compareWith([{ filename: 'O24OpenAPI/O24OpenAPI.OData/src/O24OpenAPI.OData/Foo.cs', status: 'modified' }]), fixtureGraph())
  assert.deepEqual(result.affectedServices, ['WFO'])
  assert.equal(result.fellBackToAll, false)
})
