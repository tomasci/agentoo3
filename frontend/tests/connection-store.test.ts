// shared/store/connection.ts — the set of stream keys currently in the
// "erroring, retry scheduled" state, and its two writers.
//
// Every case gets a fresh `createStore()`: the atoms are module-level, and the
// default store is shared with every other file that mounts a stream hook
// without a Provider.

import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  addReconnectingStreamAtom,
  reconnectingStreamsAtom,
  removeReconnectingStreamAtom,
} from '../src/shared/store/connection'

const keys = (store: ReturnType<typeof createStore>) =>
  [...store.get(reconnectingStreamsAtom)].sort()

test('starts empty', () => {
  const store = createStore()
  expect(store.get(reconnectingStreamsAtom).size).toBe(0)
})

test('add puts the key in the set', () => {
  const store = createStore()
  store.set(addReconnectingStreamAtom, 's1')
  expect(store.get(reconnectingStreamsAtom).has('s1')).toBe(true)
  expect(keys(store)).toEqual(['s1'])
})

test('add replaces the set with a new one rather than mutating it', () => {
  const store = createStore()
  const before = store.get(reconnectingStreamsAtom)
  store.set(addReconnectingStreamAtom, 's1')
  expect(store.get(reconnectingStreamsAtom) === before).toBe(false)
  // The old value is untouched — a mutated-in-place Set would re-render nothing.
  expect(before.has('s1')).toBe(false)
})

test('adding a key already present leaves the value identity-equal', () => {
  const store = createStore()
  store.set(addReconnectingStreamAtom, 's1')
  const before = store.get(reconnectingStreamsAtom)
  store.set(addReconnectingStreamAtom, 's1')
  expect(store.get(reconnectingStreamsAtom) === before).toBe(true)
  expect(keys(store)).toEqual(['s1'])
})

test('removing an absent key leaves the value identity-equal (empty and non-empty)', () => {
  const store = createStore()
  const empty = store.get(reconnectingStreamsAtom)
  store.set(removeReconnectingStreamAtom, 'nope')
  expect(store.get(reconnectingStreamsAtom) === empty).toBe(true)

  store.set(addReconnectingStreamAtom, 's1')
  const one = store.get(reconnectingStreamsAtom)
  store.set(removeReconnectingStreamAtom, 'nope')
  expect(store.get(reconnectingStreamsAtom) === one).toBe(true)
  expect(keys(store)).toEqual(['s1'])
})

test('a no-op write notifies no subscriber', () => {
  const store = createStore()
  store.set(addReconnectingStreamAtom, 's1')
  let notified = 0
  const unsub = store.sub(reconnectingStreamsAtom, () => {
    notified++
  })
  store.set(addReconnectingStreamAtom, 's1')
  store.set(removeReconnectingStreamAtom, 'absent')
  expect(notified).toBe(0)
  store.set(removeReconnectingStreamAtom, 's1')
  expect(notified).toBe(1)
  unsub()
})

test('remove takes the key out, with a new set', () => {
  const store = createStore()
  store.set(addReconnectingStreamAtom, 's1')
  const before = store.get(reconnectingStreamsAtom)
  store.set(removeReconnectingStreamAtom, 's1')
  expect(store.get(reconnectingStreamsAtom).has('s1')).toBe(false)
  expect(store.get(reconnectingStreamsAtom).size).toBe(0)
  expect(store.get(reconnectingStreamsAtom) === before).toBe(false)
  expect(before.has('s1')).toBe(true)
})

test('add and remove leave other keys untouched', () => {
  const store = createStore()
  store.set(addReconnectingStreamAtom, 'a')
  store.set(addReconnectingStreamAtom, 'b')
  store.set(addReconnectingStreamAtom, 'c')
  expect(keys(store)).toEqual(['a', 'b', 'c'])
  store.set(removeReconnectingStreamAtom, 'b')
  expect(keys(store)).toEqual(['a', 'c'])
  store.set(addReconnectingStreamAtom, 'b')
  expect(keys(store)).toEqual(['a', 'b', 'c'])
})

test('two stores do not share state', () => {
  const one = createStore()
  const two = createStore()
  one.set(addReconnectingStreamAtom, 's1')
  expect(two.get(reconnectingStreamsAtom).size).toBe(0)
})
