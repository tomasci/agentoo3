import { expect, test } from 'bun:test'
import {
  activeTabIdForPath,
  adoptTab,
  closeTab,
  newTab,
  nextNewTabSeq,
  normalizeTabs,
  openProject,
  projectTab,
  projectTabId,
  pruneProjectTabs,
  rememberPath,
  shellModeForPath,
  SYSTEM_TAB_ID,
  type Tab,
  systemTab,
} from '../src/shared/store/tabs'

const ids = (tabs: Tab[]) => tabs.map((tab) => tab.id)

// ── which tab a URL belongs to ───────────────────────────────────────────────

test('a URL names its own tab, so links open what the sender saw', () => {
  expect(activeTabIdForPath('/projects/abc')).toBe(projectTabId('abc'))
  expect(activeTabIdForPath('/projects/abc/sessions/s1')).toBe(projectTabId('abc'))
  expect(activeTabIdForPath('/tab/new-2')).toBe('new-2')
  expect(activeTabIdForPath('/library')).toBe(SYSTEM_TAB_ID)
  expect(activeTabIdForPath('/library/agents/tester')).toBe(SYSTEM_TAB_ID)
  expect(activeTabIdForPath('/settings')).toBe(SYSTEM_TAB_ID)
  // Not a project page: no id, so it is not any project's tab.
  expect(activeTabIdForPath('/projects')).toBe(SYSTEM_TAB_ID)
})

test('the shell is chosen by the path, so it is right on first paint', () => {
  expect(shellModeForPath('/projects/abc/sessions')).toBe('project')
  expect(shellModeForPath('/tab/new-1')).toBe('new')
  expect(shellModeForPath('/ssh-keys')).toBe('system')
  // An empty tab shows the picker with no sidebar at all.
  expect(shellModeForPath('/tab/new-1')).not.toBe('system')
})

// ── opening projects ─────────────────────────────────────────────────────────

test('opening a project from the system tab appends a tab', () => {
  const result = openProject([systemTab()], 'abc', SYSTEM_TAB_ID)
  expect(ids(result.tabs)).toEqual([SYSTEM_TAB_ID, projectTabId('abc')])
  expect(result.activeId).toBe(projectTabId('abc'))
  expect(result.tabs[1]?.path).toBe('/projects/abc')
})

test('the picker becomes the project, keeping its place in the row', () => {
  const tabs = [systemTab(), newTab(1), projectTab('zzz')]
  const result = openProject(tabs, 'abc', 'new-1')

  // Position is kept: the tab you filled in is the tab you end up in, and the
  // tabs to its right do not shuffle underneath the pointer.
  expect(ids(result.tabs)).toEqual([SYSTEM_TAB_ID, projectTabId('abc'), projectTabId('zzz')])
  expect(result.activeId).toBe(projectTabId('abc'))
})

test('a project is never open twice — asking again focuses the tab it is in', () => {
  const tabs = [systemTab(), projectTab('abc'), newTab(1)]
  const result = openProject(tabs, 'abc', 'new-1')

  expect(ids(result.tabs)).toEqual([SYSTEM_TAB_ID, projectTabId('abc')])
  expect(result.activeId).toBe(projectTabId('abc'))
})

test('focusing an already-open project keeps the tab you asked from, if it holds a project', () => {
  // Asking from a project tab is a jump, not a hand-off: nothing gets retired.
  const tabs = [systemTab(), projectTab('abc'), projectTab('def')]
  const result = openProject(tabs, 'abc', projectTabId('def'))

  expect(ids(result.tabs)).toEqual([SYSTEM_TAB_ID, projectTabId('abc'), projectTabId('def')])
  expect(result.activeId).toBe(projectTabId('abc'))
})

test('a reopened project starts at its overview, not wherever it was last time', () => {
  const stale = { ...projectTab('abc'), path: '/projects/abc/sessions/s1' }
  const closed = closeTab([systemTab(), stale], projectTabId('abc'))
  const reopened = openProject(closed.tabs, 'abc', SYSTEM_TAB_ID)
  expect(reopened.tabs[1]?.path).toBe('/projects/abc')
})

// ── closing ──────────────────────────────────────────────────────────────────

test('closing hands over to the tab on the right, as a browser does', () => {
  const tabs = [systemTab(), projectTab('a'), projectTab('b'), projectTab('c')]
  const result = closeTab(tabs, projectTabId('b'))

  expect(ids(result.tabs)).toEqual([SYSTEM_TAB_ID, projectTabId('a'), projectTabId('c')])
  expect(result.activeId).toBe(projectTabId('c'))
})

test('closing the last tab falls back to its left, never to nothing', () => {
  const tabs = [systemTab(), projectTab('a')]
  const result = closeTab(tabs, projectTabId('a'))

  expect(ids(result.tabs)).toEqual([SYSTEM_TAB_ID])
  expect(result.activeId).toBe(SYSTEM_TAB_ID)
})

test('the system tab cannot be closed', () => {
  const tabs = [systemTab(), projectTab('a')]
  const result = closeTab(tabs, SYSTEM_TAB_ID)

  expect(result.tabs).toBe(tabs)
  expect(ids(result.tabs)).toContain(SYSTEM_TAB_ID)
})

test('closing a tab that is not there changes nothing', () => {
  const tabs = [systemTab(), projectTab('a')]
  expect(closeTab(tabs, 'project-nope').tabs).toBe(tabs)
})

// ── new-tab numbering ────────────────────────────────────────────────────────

test('new tabs take the lowest free number, so closing one frees it again', () => {
  expect(nextNewTabSeq([systemTab()])).toBe(1)
  expect(nextNewTabSeq([systemTab(), newTab(1)])).toBe(2)
  // 1 was closed: reuse it rather than climbing to 3.
  expect(nextNewTabSeq([systemTab(), newTab(2)])).toBe(1)
  expect(nextNewTabSeq([systemTab(), newTab(1), newTab(2), newTab(3)])).toBe(4)
})

test('two empty tabs are two different tabs', () => {
  const first = newTab(nextNewTabSeq([systemTab()]))
  const second = newTab(nextNewTabSeq([systemTab(), first]))
  expect(first.id).not.toBe(second.id)
  expect(second.path).toBe(`/tab/${second.id}`)
})

// ── deep links ───────────────────────────────────────────────────────────────

test('a pasted project link opens a real tab at that page', () => {
  const tabs = adoptTab([systemTab()], projectTabId('abc'), '/projects/abc/sessions/s1', ['abc'])

  expect(ids(tabs)).toEqual([SYSTEM_TAB_ID, projectTabId('abc')])
  // Kept at the page the link pointed at, not bounced to the overview.
  expect(tabs[1]?.path).toBe('/projects/abc/sessions/s1')
})

test('a reloaded empty tab comes back as an empty tab', () => {
  const tabs = adoptTab([systemTab()], 'new-7', '/tab/new-7', [])
  expect(ids(tabs)).toEqual([SYSTEM_TAB_ID, 'new-7'])
  expect(tabs[1]?.kind).toBe('new')
})

test('an id the URL cannot account for is not invented as a tab', () => {
  const tabs = [systemTab()]
  // The path says project abc, so it cannot vouch for a tab named def.
  expect(adoptTab(tabs, projectTabId('def'), '/projects/abc', ['abc', 'def'])).toBe(tabs)
  expect(adoptTab(tabs, 'made-up', '/library', [])).toBe(tabs)
  expect(adoptTab(tabs, 'new-x', '/tab/new-x', [])).toBe(tabs)
})

test('a link to a project the server does not have opens no tab', () => {
  // Otherwise adoption and pruning would fight, each undoing the other on
  // every render for as long as the stale link stayed in the address bar.
  const tabs = [systemTab()]
  expect(adoptTab(tabs, projectTabId('gone'), '/projects/gone', ['abc'])).toBe(tabs)
})

test('adopting a tab already open is a no-op', () => {
  const tabs = [systemTab(), projectTab('abc')]
  expect(adoptTab(tabs, projectTabId('abc'), '/projects/abc', ['abc'])).toBe(tabs)
})

// ── keeping up with the server ───────────────────────────────────────────────

test('a deleted project loses its tab, and only its tab', () => {
  const tabs = [systemTab(), projectTab('a'), newTab(1), projectTab('b')]
  const pruned = pruneProjectTabs(tabs, ['b'])

  expect(ids(pruned)).toEqual([SYSTEM_TAB_ID, 'new-1', projectTabId('b')])
})

test('pruning with every project still present returns the very same array', () => {
  const tabs = [systemTab(), projectTab('a'), projectTab('b')]

  // `toBe`, not `toEqual`: the effect that prunes compares by identity to
  // decide whether to write, so an equal-but-new array is a write on every
  // render — an infinite loop, not a cosmetic inefficiency.
  expect(pruneProjectTabs(tabs, ['a', 'b'])).toBe(tabs)
  // Extra projects on the server are not this function's business either.
  expect(pruneProjectTabs(tabs, ['a', 'b', 'c'])).toBe(tabs)
})

test('nothing to prune means no write, for every shape of row', () => {
  // The loop this guards reproduced with the plainest state there is: one
  // system tab and no projects at all.
  for (const row of [[systemTab()], [systemTab(), newTab(1)], [systemTab(), projectTab('a')]]) {
    const ids = row.flatMap((tab) => (tab.projectId ? [tab.projectId] : []))
    expect(pruneProjectTabs(row, ids)).toBe(row)
  }
})

// ── remembered locations ─────────────────────────────────────────────────────

test('a tab remembers where it was looking', () => {
  const tabs = [systemTab(), projectTab('abc')]
  const moved = rememberPath(tabs, projectTabId('abc'), '/projects/abc/sessions')

  expect(moved[1]?.path).toBe('/projects/abc/sessions')
  // The other tabs are left exactly as they were.
  expect(moved[0]).toBe(tabs[0])
})

test('remembering the same place returns the same array, so nothing re-renders', () => {
  const tabs = [systemTab(), projectTab('abc')]
  expect(rememberPath(tabs, projectTabId('abc'), '/projects/abc')).toBe(tabs)
  expect(rememberPath(tabs, 'project-gone', '/projects/gone')).toBe(tabs)
})

// ── storage is untrusted input ───────────────────────────────────────────────

test('the system tab is always present, and always first', () => {
  expect(ids(normalizeTabs([]))).toEqual([SYSTEM_TAB_ID])
  expect(ids(normalizeTabs([projectTab('a')]))).toEqual([SYSTEM_TAB_ID, projectTabId('a')])
  expect(ids(normalizeTabs([projectTab('a'), systemTab()]))).toEqual([
    SYSTEM_TAB_ID,
    projectTabId('a'),
  ])
})

test('a stored list from another build cannot leave the workspace empty', () => {
  // Every one of these is junk of a kind localStorage can really hold: a shape
  // from an older release, a hand-edited value, a half-written array.
  for (const junk of [null, undefined, 'system', 42, {}, [null], [{ id: 'x' }]]) {
    expect(ids(normalizeTabs(junk))).toEqual([SYSTEM_TAB_ID])
  }
})

test('malformed entries are dropped, sound ones kept', () => {
  const tabs = normalizeTabs([
    systemTab(),
    { id: 'project-a', kind: 'project', projectId: 'a', path: '/projects/a' },
    { id: 'project-b', kind: 'project', path: '/projects/b' }, // no projectId
    { id: 'new-1', kind: 'new', path: '/tab/new-1' },
    { id: 'new-2', kind: 'elsewhere', path: '/tab/new-2' }, // unknown kind
    { id: 'new-1', kind: 'new', path: '/tab/new-1' }, // duplicate id
  ])

  expect(ids(tabs)).toEqual([SYSTEM_TAB_ID, 'project-a', 'new-1'])
})

test('a duplicated project cannot come back from storage', () => {
  const tabs = normalizeTabs([systemTab(), projectTab('a'), projectTab('a')])
  expect(ids(tabs)).toEqual([SYSTEM_TAB_ID, projectTabId('a')])
})
