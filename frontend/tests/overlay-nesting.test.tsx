// Base UI's Dialog runs a one-shot `aria-hidden` walk over the rest of the
// document when it opens (the same mechanism every modal-dialog primitive in
// this family uses to hide the background from assistive tech). A popup that
// portals to `document.body` instead of into the dialog's own portal would
// get caught by that walk — hidden along with everything else outside the
// dialog — which is exactly the bug this guards against for every "opens a
// popup from inside a dialog" case a later feature track will hit: a Select
// for a field, a DropdownMenu for a row of actions, a Tooltip on a control.
//
// A toast is the deliberate exception: `Toaster` is mounted once in the app
// shell, not inside any one dialog, and a toast raised by a dialog action
// must outlive that dialog closing — so it stays outside the dialog's portal
// on purpose, and this file checks that it is still reachable (not caught by
// the same aria-hidden walk) rather than that it is nested inside.

import { afterEach, expect, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Toaster, toast } from '@/shared/ui/toast'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/ui/tooltip'

let root: Root | undefined
let host: HTMLElement

async function mount(ui: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(ui)
  })
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

function insideDialogPortal(el: Element | null) {
  return el?.closest('[data-slot="dialog-portal"]') != null
}

function hasAriaHiddenAncestor(el: Element | null) {
  let node = el
  while (node && node !== document.body) {
    if (node.getAttribute('aria-hidden') === 'true') return true
    node = node.parentElement
  }
  return false
}

test('a select opened inside an open dialog renders inside the dialog portal, not under an aria-hidden ancestor', async () => {
  await mount(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
        <Select
          defaultValue="a"
          items={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ]}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Alpha</SelectItem>
            <SelectItem value="b">Beta</SelectItem>
          </SelectContent>
        </Select>
      </DialogContent>
    </Dialog>,
  )
  await flush()

  const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement
  await act(async () => {
    trigger.click()
  })
  await flush()

  const listbox = document.querySelector('[role="listbox"]')
  expect(listbox).not.toBeNull()
  expect(insideDialogPortal(listbox)).toBe(true)
  expect(hasAriaHiddenAncestor(listbox)).toBe(false)
})

test('a dropdown menu opened inside an open dialog renders inside the dialog portal, not under an aria-hidden ancestor', async () => {
  const picked: string[] = []
  await mount(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Row</DialogTitle>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button />}>More</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => picked.push('a')}>A</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </DialogContent>
    </Dialog>,
  )
  await flush()

  const trigger = [...document.querySelectorAll('button')].find((b) => b.textContent === 'More') as HTMLElement
  await act(async () => {
    trigger.click()
  })
  await flush()

  const menu = document.querySelector('[role="menu"]')
  expect(menu).not.toBeNull()
  expect(insideDialogPortal(menu)).toBe(true)
  expect(hasAriaHiddenAncestor(menu)).toBe(false)

  await act(async () => {
    ;(document.querySelector('[role="menuitem"]') as HTMLElement)?.click()
  })
  expect(picked).toEqual(['a'])
})

test('a tooltip opened inside an open dialog renders inside the dialog portal, not under an aria-hidden ancestor', async () => {
  await mount(
    <TooltipProvider>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Status</DialogTitle>
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} />}>CPU</TooltipTrigger>
            <TooltipContent>Load</TooltipContent>
          </Tooltip>
        </DialogContent>
      </Dialog>
    </TooltipProvider>,
  )
  await flush()

  const trigger = document.querySelector('[data-slot="tooltip-trigger"]') as HTMLElement
  await act(async () => {
    trigger.focus()
  })
  await flush()

  const content = document.querySelector('[data-slot="tooltip-content"]')
  expect(content).not.toBeNull()
  expect(insideDialogPortal(content)).toBe(true)
  expect(hasAriaHiddenAncestor(content)).toBe(false)
})

test('a toast raised while a dialog is open stays outside the dialog portal and reachable', async () => {
  await mount(
    <>
      <Toaster />
      <Dialog open>
        <DialogContent>
          <DialogTitle>Status</DialogTitle>
        </DialogContent>
      </Dialog>
    </>,
  )
  await flush()

  await act(async () => {
    toast.add({ title: 'Saved' })
  })
  await flush()

  const raised = document.querySelector('[data-slot="toast"]')
  expect(raised).not.toBeNull()
  expect(insideDialogPortal(raised)).toBe(false)
  expect(hasAriaHiddenAncestor(raised)).toBe(false)
})
