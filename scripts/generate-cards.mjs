/**
 * Generates all profile SVG cards locally so the README never depends on a
 * third-party rendering service (those constantly 503 under load).
 *
 * Run: node scripts/generate-cards.mjs
 * Uses GITHUB_TOKEN when present (enables GraphQL commit/PR/issue counts and
 * raises the rate limit); falls back to unauthenticated REST for local preview.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const USER = process.env.PROFILE_USER || '7pak'
const TOKEN = process.env.GITHUB_TOKEN || ''
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets')

const FEATURED = ['Recallly', 'Autoinvo', 'LonePaw-PetAdoption', 'Tasty-Table']

const THEME = {
  bg: '#0D1117',
  border: '#21262D',
  title: '#7C3AED',
  text: '#C9D1D9',
  dim: '#8B949E',
  accent: '#A78BFA',
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
}

// GitHub linguist colours for the languages that actually show up.
const LANG_COLORS = {
  Kotlin: '#A97BFF', Dart: '#00B4AB', Java: '#b07219', JavaScript: '#f1e05a',
  TypeScript: '#3178c6', HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c',
  Python: '#3572A5', Shell: '#89e051', Swift: '#F05138', Go: '#00ADD8',
  Ruby: '#701516', PHP: '#4F5D95', 'C#': '#178600', 'C++': '#f34b7d',
  C: '#555555', Rust: '#dea584', Vue: '#41b883', 'Objective-C': '#438eff',
  Makefile: '#427819', CMake: '#DA3434', Batchfile: '#C1F12E', Procfile: '#8B949E',
}
const langColor = (name) => LANG_COLORS[name] || '#8B949E'

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const headers = () => {
  const h = { 'User-Agent': `${USER}-profile-cards`, Accept: 'application/vnd.github+json' }
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`
  return h
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers() })
  if (!res.ok) throw new Error(`REST ${path} -> ${res.status}`)
  return res.json()
}

async function graphql(query, variables) {
  if (!TOKEN) return null
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) return null
  const json = await res.json()
  if (json.errors) {
    console.warn('graphql errors:', JSON.stringify(json.errors))
    return null
  }
  return json.data
}

/** Rough advance-width estimate so text can be truncated before it overflows. */
function widthOf(text, size) {
  let w = 0
  for (const ch of text) {
    if ('iljtfrI.,:;\'"|!'.includes(ch)) w += 0.32
    else if ('mwMW@'.includes(ch)) w += 0.92
    else if (ch === ' ') w += 0.28
    else if (ch >= 'A' && ch <= 'Z') w += 0.68
    else w += 0.55
  }
  return w * size
}

function truncate(text, size, maxWidth) {
  if (widthOf(text, size) <= maxWidth) return text
  let out = ''
  for (const ch of text) {
    if (widthOf(out + ch + '…', size) > maxWidth) break
    out += ch
  }
  return out.trimEnd() + '…'
}

/** Greedy word wrap into at most `maxLines` lines. */
function wrap(text, size, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word
    if (widthOf(next, size) > maxWidth && cur) {
      lines.push(cur)
      cur = word
      if (lines.length === maxLines) break
    } else {
      cur = next
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur)
  if (lines.length === maxLines && cur && lines[maxLines - 1] !== cur) {
    lines[maxLines - 1] = truncate(`${lines[maxLines - 1]} ${cur}`, size, maxWidth)
  }
  return lines
}

const shell = (w, h, title, body) => `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title)}">
  <style>
    .t { font: 600 17px ${THEME.font}; fill: ${THEME.title} }
    .k { font: 400 14px ${THEME.font}; fill: ${THEME.text} }
    .v { font: 700 14px ${THEME.font}; fill: ${THEME.accent} }
    .s { font: 400 12px ${THEME.font}; fill: ${THEME.dim} }
    .in { opacity: 0; animation: fade .5s ease-in-out forwards }
    @keyframes fade { to { opacity: 1 } }
  </style>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="25" y="34" class="t">${esc(title)}</text>
  ${body}
</svg>`

// ---------------------------------------------------------------- data

async function collect() {
  const user = await rest(`/users/${USER}`)

  const repos = []
  for (let page = 1; page <= 5; page++) {
    const batch = await rest(`/users/${USER}/repos?per_page=100&page=${page}&type=owner`)
    repos.push(...batch)
    if (batch.length < 100) break
  }
  const owned = repos.filter((r) => !r.fork && !r.archived)

  const stars = owned.reduce((n, r) => n + r.stargazers_count, 0)
  const forks = owned.reduce((n, r) => n + r.forks_count, 0)

  // Language byte counts, summed across every owned repo.
  const bytes = {}
  for (const repo of owned) {
    try {
      const langs = await rest(`/repos/${USER}/${repo.name}/languages`)
      for (const [name, n] of Object.entries(langs)) bytes[name] = (bytes[name] || 0) + n
    } catch (err) {
      console.warn(`languages for ${repo.name}: ${err.message}`)
    }
  }

  const gql = await graphql(
    `query($login: String!) {
      user(login: $login) {
        pullRequests { totalCount }
        issues { totalCount }
        contributionsCollection {
          totalCommitContributions
          restrictedContributionsCount
        }
        repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE]) { totalCount }
      }
    }`,
    { login: USER },
  )

  const c = gql?.user?.contributionsCollection
  return {
    name: user.name || user.login,
    followers: user.followers,
    repoCount: owned.length,
    stars,
    forks,
    bytes,
    commits: c ? c.totalCommitContributions + c.restrictedContributionsCount : null,
    prs: gql?.user?.pullRequests?.totalCount ?? null,
    issues: gql?.user?.issues?.totalCount ?? null,
    contributedTo: gql?.user?.repositoriesContributedTo?.totalCount ?? null,
    repos: Object.fromEntries(repos.map((r) => [r.name, r])),
  }
}

// ---------------------------------------------------------------- cards

function statsCard(d) {
  const rows = [
    ['Total Stars Earned', d.stars],
    ['Total Forks', d.forks],
    ['Public Repositories', d.repoCount],
    ['Followers', d.followers],
  ]
  if (d.commits !== null) rows.splice(1, 0, ['Commits (last year)', d.commits])
  if (d.prs !== null) rows.push(['Pull Requests', d.prs])
  if (d.issues !== null) rows.push(['Issues Opened', d.issues])

  const w = 420
  const h = 70 + rows.length * 26
  const body = rows
    .map(([label, value], i) => {
      const y = 66 + i * 26
      return `<g class="in" style="animation-delay:${150 + i * 70}ms">
    <circle cx="30" cy="${y - 4}" r="3" fill="${THEME.title}"/>
    <text x="44" y="${y}" class="k">${esc(label)}</text>
    <text x="${w - 25}" y="${y}" class="v" text-anchor="end">${value}</text>
  </g>`
    })
    .join('\n  ')

  return shell(w, h, `${d.name} — GitHub Stats`, body)
}

function langsCard(d) {
  const total = Object.values(d.bytes).reduce((a, b) => a + b, 0)
  const top = Object.entries(d.bytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => ({ name, pct: (n / total) * 100 }))

  const w = 420
  const barY = 56
  const barW = w - 50
  const rows = Math.ceil(top.length / 2)
  const h = barY + 28 + rows * 24 + 10

  let x = 25
  const bar = top
    .map((l, i) => {
      const seg = Math.max((l.pct / 100) * barW, 3)
      const rect = `<rect x="${x.toFixed(1)}" y="${barY}" width="${seg.toFixed(1)}" height="10" fill="${langColor(l.name)}"/>`
      x += seg
      return rect
    })
    .join('\n    ')

  const legend = top
    .map((l, i) => {
      const col = i % 2
      const row = Math.floor(i / 2)
      const lx = 25 + col * (barW / 2)
      const ly = barY + 46 + row * 24
      return `<g class="in" style="animation-delay:${200 + i * 70}ms">
    <circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${langColor(l.name)}"/>
    <text x="${lx + 18}" y="${ly}" class="k">${esc(l.name)}</text>
    <text x="${lx + barW / 2 - 30}" y="${ly}" class="s" text-anchor="end">${l.pct.toFixed(1)}%</text>
  </g>`
    })
    .join('\n  ')

  const body = `<clipPath id="round"><rect x="25" y="${barY}" width="${barW}" height="10" rx="5"/></clipPath>
  <g clip-path="url(#round)">
    <rect x="25" y="${barY}" width="${barW}" height="10" fill="${THEME.border}"/>
    ${bar}
  </g>
  ${legend}`

  return shell(w, h, 'Most Used Languages', body)
}

function repoCard(repo) {
  const w = 420
  const h = 130
  const desc = wrap(repo.description || 'No description provided.', 13, w - 50, 2)
  const lang = repo.language

  const meta = []
  if (lang) {
    meta.push(`<circle cx="27" cy="${h - 26}" r="5" fill="${langColor(lang)}"/>
  <text x="40" y="${h - 22}" class="s">${esc(lang)}</text>`)
  }
  let mx = lang ? 40 + widthOf(lang, 12) + 22 : 25
  meta.push(`<path transform="translate(${mx}, ${h - 33})" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" fill="${THEME.dim}"/>
  <text x="${mx + 21}" y="${h - 22}" class="s">${repo.stargazers_count}</text>`)
  mx += 21 + widthOf(String(repo.stargazers_count), 12) + 20
  meta.push(`<path transform="translate(${mx}, ${h - 33})" d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0Z" fill="${THEME.dim}"/>
  <text x="${mx + 20}" y="${h - 22}" class="s">${repo.forks_count}</text>`)

  const body = `<g class="in" style="animation-delay:120ms">
    <path transform="translate(25, 20)" d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Z" fill="${THEME.title}"/>
    <text x="46" y="32" class="t" style="font-size:16px">${esc(truncate(repo.name, 16, w - 90))}</text>
  </g>
  ${desc
    .map(
      (line, i) =>
        `<text x="25" y="${62 + i * 20}" class="k" style="font-size:13px" fill="${THEME.dim}">${esc(line)}</text>`,
    )
    .join('\n  ')}
  <g class="in" style="animation-delay:260ms">
    ${meta.join('\n    ')}
  </g>`

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(repo.name)}">
  <style>
    .t { font: 600 17px ${THEME.font}; fill: ${THEME.title} }
    .k { font: 400 14px ${THEME.font}; fill: ${THEME.text} }
    .s { font: 400 12px ${THEME.font}; fill: ${THEME.dim} }
    .in { opacity: 0; animation: fade .5s ease-in-out forwards }
    @keyframes fade { to { opacity: 1 } }
  </style>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${THEME.bg}" stroke="${THEME.border}"/>
  ${body}
</svg>`
}

// ---------------------------------------------------------------- main

const data = await collect()
await mkdir(OUT, { recursive: true })

const written = []
async function emit(file, svg) {
  await writeFile(join(OUT, file), svg, 'utf8')
  written.push(file)
}

await emit('stats.svg', statsCard(data))
await emit('top-langs.svg', langsCard(data))

for (const name of FEATURED) {
  const repo = data.repos[name]
  if (!repo) {
    console.warn(`skipping missing repo: ${name}`)
    continue
  }
  await emit(`repo-${name}.svg`, repoCard(repo))
}

console.log(`stats: stars=${data.stars} forks=${data.forks} repos=${data.repoCount} followers=${data.followers} commits=${data.commits} prs=${data.prs} issues=${data.issues}`)
console.log(`languages: ${Object.keys(data.bytes).length} detected`)
console.log(`wrote ${written.length} cards -> ${written.join(', ')}`)
