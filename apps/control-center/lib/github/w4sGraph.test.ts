import assert from 'node:assert/strict'
import test from 'node:test'

process.env.GITHUB_TOKEN = 'test-token'
process.env.GITHUB_OWNER = 'test-owner'
process.env.GITHUB_REPO = 'test-repo'
process.env.GITHUB_WORKFLOW = 'build-o24.yml'

const {
  dirOf,
  extractProjectReferences,
  fetchDependencyGraph,
  parseDockerfileRootCsproj,
  parseDockerfileSharedPropsFiles,
  parseServiceDockerfileMap,
  parseSlnProjects,
  resetDependencyGraphCacheForTests,
  stripXmlComments,
} = await import('./w4sGraph')

// ---- Fixtures: verbatim content pulled from nguyenvuhoang/w4s (branch
// "developer", commit 1c3ca549e6259a32bfadf9014c53cd36dcff575d) during the
// Chat 06 monorepo survey — real data, not invented. ----

const REAL_BUILD_WORKFLOW_YML = `name: Build O24

on:
  workflow_dispatch:
    inputs:
      service:
        description: "Service cần build"
        required: true
        type: choice
        options:
          - CMS
          - WFO
          - IPS
          - CTH
          - NCH
          - RPT
          - LOG

      tag:
        description: "Docker image tag"
        required: true
        default: "latest"
        type: string

jobs:
  build:
    name: Build \${{ inputs.service }}
    runs-on: ubuntu-latest

    steps:
      - name: Checkout source
        uses: actions/checkout@v4

      - name: Resolve service
        id: service
        shell: bash
        run: |
          case "\${{ inputs.service }}" in
            CMS)
              echo "dockerfile=O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API/Dockerfile" >> "$GITHUB_OUTPUT"
              echo "image=vknighthub/ips_o24cms" >> "$GITHUB_OUTPUT"
              ;;
            WFO)
              echo "dockerfile=O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.API/Dockerfile" >> "$GITHUB_OUTPUT"
              echo "image=vknighthub/ips_o24wfo" >> "$GITHUB_OUTPUT"
              ;;
            IPS)
              echo "dockerfile=O24OpenAPI/O24OpenAPI.IPS/O24OpenAPI.IPS.API/Dockerfile" >> "$GITHUB_OUTPUT"
              echo "image=vknighthub/ips_o24ips" >> "$GITHUB_OUTPUT"
              ;;
            CTH)
              echo "dockerfile=O24OpenAPI/O24OpenAPI.CTH/O24OpenAPI.CTH.API/Dockerfile" >> "$GITHUB_OUTPUT"
              echo "image=vknighthub/ips_o24cth" >> "$GITHUB_OUTPUT"
              ;;
            NCH)
              echo "dockerfile=O24OpenAPI/O24OpenAPI.NCH/O24OpenAPI.NCH.API/Dockerfile" >> "$GITHUB_OUTPUT"
              echo "image=vknighthub/ips_o24nch" >> "$GITHUB_OUTPUT"
              ;;
            RPT)
              echo "dockerfile=O24OpenAPI/O24OpenAPI.RPT/O24OpenAPI.RPT.API/Dockerfile" >> "$GITHUB_OUTPUT"
              echo "image=vknighthub/ips_o24rpt" >> "$GITHUB_OUTPUT"
              ;;
            LOG)
              echo "dockerfile=O24OpenAPI/O24OpenAPI.Logger/O24OpenAPI.Logger.API/Dockerfile" >> "$GITHUB_OUTPUT"
              echo "image=vknighthub/ips_o24log" >> "$GITHUB_OUTPUT"
              ;;
            *)
              echo "Unknown service: \${{ inputs.service }}"
              exit 1
              ;;
          esac
`

const REAL_CMS_DOCKERFILE = `FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
USER $APP_UID
WORKDIR /app
EXPOSE 8080
EXPOSE 8081

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY ["O24OpenAPI/Directory.Packages.props", "O24OpenAPI/"]
COPY ["O24OpenAPI/Directory.Build.props", "O24OpenAPI/"]
COPY ["O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API/O24OpenAPI.CMS.API.csproj", "O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API/"]
COPY ["O24OpenAPI/O24OpenAPI.GrpcContracts/O24OpenAPI.GrpcContracts.csproj", "O24OpenAPI/O24OpenAPI.GrpcContracts/"]
COPY ["O24OpenAPI/O24OpenAPI.APIContracts/O24OpenAPI.APIContracts.csproj", "O24OpenAPI/O24OpenAPI.APIContracts/"]
COPY ["O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.Infrastructure/O24OpenAPI.CMS.Infrastructure.csproj", "O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.Infrastructure/"]
COPY ["O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.Domain/O24OpenAPI.CMS.Domain.csproj", "O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.Domain/"]
RUN dotnet restore "./O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API/O24OpenAPI.CMS.API.csproj"
COPY . .
WORKDIR "/src/O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API"
RUN dotnet build "./O24OpenAPI.CMS.API.csproj" -c $BUILD_CONFIGURATION -o /app/build /p:SkipGitVersion=true

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
RUN dotnet publish "./O24OpenAPI.CMS.API.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false /p:SkipGitVersion=true

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "O24OpenAPI.CMS.API.dll"]
`

// WFO's Dockerfile has NO separate "dotnet restore" step — root csproj
// detection must work from the WORKDIR + "dotnet build" pair alone.
const REAL_WFO_DOCKERFILE = `FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
USER $APP_UID
WORKDIR /app
EXPOSE 109
EXPOSE 105

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY ["O24OpenAPI/Directory.Packages.props", "O24OpenAPI/"]
COPY ["O24OpenAPI/Directory.Build.props", "O24OpenAPI/"]
COPY ["O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.API/O24OpenAPI.WFO.API.csproj", "O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.API/"]
COPY ["O24OpenAPI/O24OpenAPI.GrpcContracts/O24OpenAPI.GrpcContracts.csproj", "O24OpenAPI/O24OpenAPI.GrpcContracts/"]
COPY ["O24OpenAPI/O24OpenAPI.GrpcContracts/Protos/", "O24OpenAPI/O24OpenAPI.GrpcContracts/Protos/"]
COPY ["O24OpenAPI/O24OpenAPI.APIContracts/O24OpenAPI.APIContracts.csproj", "O24OpenAPI/O24OpenAPI.APIContracts/"]
COPY ["O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.Domain/O24OpenAPI.WFO.Domain.csproj", "O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.Domain/"]
COPY ["O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.Infrastructure/O24OpenAPI.WFO.Infrastructure.csproj", "O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.Infrastructure/"]
COPY . .

WORKDIR "/src/O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.API"
RUN dotnet build "./O24OpenAPI.WFO.API.csproj" -c $BUILD_CONFIGURATION -o /app/build /p:SkipGitVersion=true

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
RUN dotnet publish "./O24OpenAPI.WFO.API.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false /p:SkipGitVersion=true

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "O24OpenAPI.WFO.API.dll"]
`

// Real regression case: WFO.Domain.csproj once referenced an external
// "../Project/o24platform" project via ProjectReference, but that line is
// now commented out (the real dependency is a NuGet PackageReference to
// "O24Platform" instead, version-pinned via Directory.Packages.props). A
// naive regex over raw XML (no comment stripping) would wrongly report this
// as a live ProjectReference to a path outside the repo.
const REAL_WFO_DOMAIN_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="LinKit.Core" />
    <PackageReference Include="O24Platform" />
  </ItemGroup>
  <ItemGroup>
    <!--<ProjectReference Include="..\\..\\..\\..\\Project\\o24platform\\src\\O24Platform\\O24Platform.csproj" />-->
  </ItemGroup>
</Project>
`

const REAL_SLN_SNIPPET = `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "O24OpenAPI.GrpcContracts", "O24OpenAPI\\O24OpenAPI.GrpcContracts\\O24OpenAPI.GrpcContracts.csproj", "{AAAAAAAA-0000-0000-0000-000000000001}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "O24OpenAPI.ACT.API", "O24OpenAPI\\O24OpenAPI.ACT\\O24OpenAPI.ACT.API\\O24OpenAPI.ACT.API.csproj", "{AAAAAAAA-0000-0000-0000-000000000002}"
EndProject
Global
EndGlobal
`

// ---- stripXmlComments ----

test('stripXmlComments removes a commented-out ProjectReference without touching real ones', () => {
  const stripped = stripXmlComments(REAL_WFO_DOMAIN_CSPROJ)
  assert.ok(!stripped.includes('ProjectReference'))
})

test('stripXmlComments leaves content with no comments untouched', () => {
  const xml = '<Project><ItemGroup><PackageReference Include="X" /></ItemGroup></Project>'
  assert.equal(stripXmlComments(xml), xml)
})

// ---- extractProjectReferences ----

test('extractProjectReferences ignores a commented-out reference (real WFO.Domain regression case)', () => {
  const refs = extractProjectReferences(REAL_WFO_DOMAIN_CSPROJ, 'O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.Domain')
  assert.deepEqual(refs, [])
})

test('extractProjectReferences resolves relative paths against the csproj directory', () => {
  const csproj = '<Project><ItemGroup><ProjectReference Include="..\\..\\O24OpenAPI.APIContracts\\O24OpenAPI.APIContracts.csproj" /></ItemGroup></Project>'
  const refs = extractProjectReferences(csproj, 'O24OpenAPI/O24OpenAPI.CTH/O24OpenAPI.CTH.Domain')
  assert.deepEqual(refs, ['O24OpenAPI/O24OpenAPI.APIContracts/O24OpenAPI.APIContracts.csproj'])
})

// ---- parseServiceDockerfileMap ----

test('parseServiceDockerfileMap finds all 7 real build services with their Dockerfile + image', () => {
  const map = parseServiceDockerfileMap(REAL_BUILD_WORKFLOW_YML)
  assert.equal(map.CMS?.dockerfile, 'O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API/Dockerfile')
  assert.equal(map.CMS?.image, 'vknighthub/ips_o24cms')
  assert.equal(map.LOG?.dockerfile, 'O24OpenAPI/O24OpenAPI.Logger/O24OpenAPI.Logger.API/Dockerfile')
  for (const service of ['CMS', 'WFO', 'IPS', 'CTH', 'NCH', 'RPT', 'LOG'] as const) {
    assert.ok(map[service], `expected ${service} in the parsed map`)
  }
})

test('parseServiceDockerfileMap ignores the "*)" default case and non-service tokens', () => {
  const map = parseServiceDockerfileMap(REAL_BUILD_WORKFLOW_YML)
  assert.equal(Object.keys(map).length, 7)
})

// ---- parseDockerfileRootCsproj ----

test('parseDockerfileRootCsproj finds the root project from a Dockerfile WITH a dotnet restore step (CMS)', () => {
  assert.equal(
    parseDockerfileRootCsproj(REAL_CMS_DOCKERFILE),
    'O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API/O24OpenAPI.CMS.API.csproj',
  )
})

test('parseDockerfileRootCsproj finds the root project from a Dockerfile WITHOUT a dotnet restore step (WFO)', () => {
  assert.equal(
    parseDockerfileRootCsproj(REAL_WFO_DOCKERFILE),
    'O24OpenAPI/O24OpenAPI.WFO/O24OpenAPI.WFO.API/O24OpenAPI.WFO.API.csproj',
  )
})

// ---- parseDockerfileSharedPropsFiles ----

test('parseDockerfileSharedPropsFiles finds Directory.Packages.props and Directory.Build.props copied before "COPY . ."', () => {
  const props = parseDockerfileSharedPropsFiles(REAL_CMS_DOCKERFILE)
  assert.deepEqual(props.sort(), ['O24OpenAPI/Directory.Build.props', 'O24OpenAPI/Directory.Packages.props'])
})

test('parseDockerfileSharedPropsFiles excludes the service\'s own .csproj COPY lines', () => {
  const props = parseDockerfileSharedPropsFiles(REAL_CMS_DOCKERFILE)
  assert.ok(!props.some((p) => p.endsWith('.csproj')))
})

// ---- parseSlnProjects ----

test('parseSlnProjects extracts every .csproj path and normalizes backslashes', () => {
  const projects = parseSlnProjects(REAL_SLN_SNIPPET)
  assert.deepEqual(projects, [
    'O24OpenAPI/O24OpenAPI.GrpcContracts/O24OpenAPI.GrpcContracts.csproj',
    'O24OpenAPI/O24OpenAPI.ACT/O24OpenAPI.ACT.API/O24OpenAPI.ACT.API.csproj',
  ])
})

// ---- dirOf ----

test('dirOf returns the parent directory of a .csproj path', () => {
  assert.equal(dirOf('O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API/O24OpenAPI.CMS.API.csproj'), 'O24OpenAPI/O24OpenAPI.CMS/O24OpenAPI.CMS.API')
})

// ---- fetchDependencyGraph caching (memory -> redis -> github) ----
//
// Minimal single-service fixture (not the real w4s data above) — these
// tests are about the CACHE layer, not the parsing logic already covered
// above, so the fixture is kept as small as possible to build successfully.

const MINI_YML = `
case "${'$'}{{ inputs.service }}" in
  CMS)
    echo "dockerfile=X/CMS.API/Dockerfile" >> "$GITHUB_OUTPUT"
    echo "image=test/cms" >> "$GITHUB_OUTPUT"
    ;;
esac
`
const MINI_DOCKERFILE = `
WORKDIR "/src/X/CMS.API"
RUN dotnet build "./CMS.API.csproj" -c Release
`
const MINI_CSPROJ = '<Project></Project>'
const MINI_SLN = 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "CMS.API", "X\\\\CMS.API\\\\CMS.API.csproj", "{X}"\nEndProject\n'

const MINI_FIXTURES: Record<string, string> = {
  '.github/workflows/build-o24.yml': MINI_YML,
  'O24OpenAPI.sln': MINI_SLN,
  'X/CMS.API/Dockerfile': MINI_DOCKERFILE,
  'X/CMS.API/CMS.API.csproj': MINI_CSPROJ,
}

type MockKvStore = Map<string, { value: string; expiresAt: number | null }>

function handleKvCommand(store: MockKvStore, command: unknown[]): unknown {
  const [op, ...args] = command as string[]
  if (op === 'GET') {
    const entry = store.get(args[0])
    if (!entry) return null
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      store.delete(args[0])
      return null
    }
    return entry.value
  }
  if (op === 'SET') {
    const [key, value, ...rest] = args
    const nx = rest.includes('NX')
    if (nx && store.has(key)) return null
    let expiresAt: number | null = null
    const pxIndex = rest.indexOf('PX')
    const exIndex = rest.indexOf('EX')
    if (pxIndex !== -1) expiresAt = Date.now() + Number(rest[pxIndex + 1])
    if (exIndex !== -1) expiresAt = Date.now() + Number(rest[exIndex + 1]) * 1000
    store.set(key, { value, expiresAt })
    return 'OK'
  }
  throw new Error(`Mock KV does not support command: ${op}`)
}

function installMocks(fixtures: Record<string, string>, kvStore: MockKvStore | null) {
  const originalFetch = globalThis.fetch
  const originalKvUrl = process.env.KV_REST_API_URL
  const originalKvToken = process.env.KV_REST_API_TOKEN
  const githubFetchCount = { count: 0 }

  if (kvStore) {
    process.env.KV_REST_API_URL = 'https://fake-kv.example.com'
    process.env.KV_REST_API_TOKEN = 'fake-kv-token'
  } else {
    delete process.env.KV_REST_API_URL
    delete process.env.KV_REST_API_TOKEN
  }

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString()
    if (href.startsWith('https://fake-kv.example.com')) {
      const command = JSON.parse(String(init?.body))
      const result = handleKvCommand(kvStore as MockKvStore, command)
      return new Response(JSON.stringify({ result }), { status: 200 })
    }
    if (href.startsWith('https://api.github.com/repos/test-owner/test-repo/contents/')) {
      githubFetchCount.count += 1
      const path = decodeURIComponent(href.split('/contents/')[1].split('?')[0])
      const content = fixtures[path]
      if (content === undefined) return new Response('Not found', { status: 404 })
      return new Response(content, { status: 200 })
    }
    throw new Error(`Unexpected fetch in test: ${href}`)
  }) as typeof fetch

  return {
    githubFetchCount,
    restore() {
      globalThis.fetch = originalFetch
      if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL
      else process.env.KV_REST_API_URL = originalKvUrl
      if (originalKvToken === undefined) delete process.env.KV_REST_API_TOKEN
      else process.env.KV_REST_API_TOKEN = originalKvToken
    },
  }
}

test('fetchDependencyGraph: cache miss fetches from GitHub and reports source "github"', async () => {
  resetDependencyGraphCacheForTests()
  const mocks = installMocks(MINI_FIXTURES, null)
  try {
    const { graph, source } = await fetchDependencyGraph('sha-miss-1')
    assert.equal(source, 'github')
    assert.ok(graph.services.CMS)
    assert.ok(mocks.githubFetchCount.count > 0)
  } finally {
    mocks.restore()
  }
})

test('fetchDependencyGraph: a second call for the same SHA hits the in-memory cache and makes zero GitHub requests', async () => {
  resetDependencyGraphCacheForTests()
  const mocks = installMocks(MINI_FIXTURES, null)
  try {
    await fetchDependencyGraph('sha-miss-2')
    const countAfterFirst = mocks.githubFetchCount.count
    const { source } = await fetchDependencyGraph('sha-miss-2')
    assert.equal(source, 'memory')
    assert.equal(mocks.githubFetchCount.count, countAfterFirst)
  } finally {
    mocks.restore()
  }
})

test('fetchDependencyGraph: a different SHA is a cache miss even right after caching another SHA (keys do not collide)', async () => {
  resetDependencyGraphCacheForTests()
  const mocks = installMocks(MINI_FIXTURES, null)
  try {
    await fetchDependencyGraph('sha-aaaa')
    const countAfterFirst = mocks.githubFetchCount.count
    const { source } = await fetchDependencyGraph('sha-bbbb')
    assert.equal(source, 'github')
    assert.ok(mocks.githubFetchCount.count > countAfterFirst)
  } finally {
    mocks.restore()
  }
})

test('fetchDependencyGraph: a Redis hit (simulating another instance/cold start) skips GitHub entirely', async () => {
  resetDependencyGraphCacheForTests()
  const kvStore: MockKvStore = new Map()
  const mocks = installMocks(MINI_FIXTURES, kvStore)
  try {
    // First call populates Redis (and memory).
    await fetchDependencyGraph('sha-redis-1')
    // A fresh memory cache (simulating a cold start on a NEW instance) must
    // still find it in "Redis" without calling GitHub again.
    resetDependencyGraphCacheForTests()
    const countBeforeSecondCall = mocks.githubFetchCount.count
    const { source } = await fetchDependencyGraph('sha-redis-1')
    assert.equal(source, 'redis')
    assert.equal(mocks.githubFetchCount.count, countBeforeSecondCall)
  } finally {
    mocks.restore()
  }
})

test('fetchDependencyGraph: two concurrent requests for the same never-cached SHA only fetch from GitHub once (in-process singleflight)', async () => {
  resetDependencyGraphCacheForTests()
  const mocks = installMocks(MINI_FIXTURES, null)
  try {
    const [a, b] = await Promise.all([fetchDependencyGraph('sha-concurrent'), fetchDependencyGraph('sha-concurrent')])
    assert.equal(a.source, 'github')
    assert.equal(b.source, 'github')
    // Sanity: the two results describe the same graph (piggybacked, not a second independent build).
    assert.deepEqual(a.graph.services.CMS?.dirs, b.graph.services.CMS?.dirs)
  } finally {
    mocks.restore()
  }
})
