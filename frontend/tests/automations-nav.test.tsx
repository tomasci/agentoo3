// The project sidebar's Automations item: directly after Ideas, linking to
// /projects/<pid>/automations, and marked current (aria-current="page") on the
// list route *and* on an automation's own detail route — and on nothing else.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  automation,
  click,
  installAutomationsServer,
  type Mounted,
  mountAt,
  text,
} from './automations-harness'

const server = await installAutomationsServer()
const { routeTree } = await import('../src/app/router')

let m: Mounted

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  server.reset()
  server.automations = [automation({ id: 'a1', name: 'Morning' })]
})
afterEach(async () => {
  await m?.unmount()
})

const sidebar = () => m.container.querySelector('[data-slot="sidebar"]')
const navLinks = () =>
  [...(sidebar()?.querySelectorAll('[data-slot="sidebar-content"] a') ?? [])].map((a) => ({
    href: a.getAttribute('href'),
    label: text(a),
  }))
const currentHrefs = () =>
  [...(sidebar()?.querySelectorAll('a[aria-current="page"]') ?? [])].map((a) =>
    a.getAttribute('href'),
  )

test("Automations sits directly after Ideas and links to the project's automations list", async () => {
  m = await mountAt(routeTree, '/projects/p1/sessions')
  const links = navLinks()
  const ideas = links.findIndex((l) => l.label === 'Ideas')
  expect(ideas).toBeGreaterThanOrEqual(0)
  expect(links[ideas + 1]).toEqual({ href: '/projects/p1/automations', label: 'Automations' })
  // An icon is rendered in the item (lucide renders an <svg>).
  const item = sidebar()?.querySelector('a[href="/projects/p1/automations"]')
  expect(item?.querySelector('svg')).not.toBeNull()
  expect(currentHrefs()).not.toContain('/projects/p1/automations')
})

test('Automations is the current item on the list route, and the only one', async () => {
  m = await mountAt(routeTree, '/projects/p1/automations')
  expect(m.router.state.location.pathname).toBe('/projects/p1/automations')
  expect(currentHrefs()).toEqual(['/projects/p1/automations'])
})

test("Automations stays the current item on an automation's detail route", async () => {
  m = await mountAt(routeTree, '/projects/p1/automations/a1')
  expect(m.router.state.location.pathname).toBe('/projects/p1/automations/a1')
  // The detail page itself rendered (not a not-found fallback).
  expect(text(m.container.querySelector('main h1'))).toBe('Morning')
  expect(currentHrefs()).toEqual(['/projects/p1/automations'])
})

test('clicking the Automations item navigates to the list', async () => {
  m = await mountAt(routeTree, '/projects/p1/sessions')
  await click(sidebar()?.querySelector('a[href="/projects/p1/automations"]'), 'Automations link')
  expect(m.router.state.location.pathname).toBe('/projects/p1/automations')
  expect(text(m.container.querySelector('main h1'))).toBe('Automations')
})
