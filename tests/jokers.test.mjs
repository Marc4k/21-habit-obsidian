import test from 'node:test'
import assert from 'node:assert/strict'
import {getJokerState, jokerUseError, normalizeDates, shiftDate, updateHabitDay} from '../src/jokers.mjs'

const today = '2026-11-15'
const run = (start, length) => Array.from({length}, (_, i) => shiftDate(start, i))
const wallet = (fm) => getJokerState(fm, today)

test('earns exactly once at each 30 completed days in a streak', () => {
	for (const length of [0, 1, 29, 30, 31, 59, 60, 90]) {
		assert.equal(wallet({entries: run('2026-01-01', length)}).balance, Math.floor(length / 30))
	}
})

test('broken streaks keep earned Jokers and reset only milestone progress', () => {
	const fm = {entries: [...run('2026-01-01', 30), ...run('2026-03-01', 29)]}
	assert.equal(wallet(fm).balance, 1)
	fm.entries.push('2026-03-30')
	assert.equal(wallet(fm).balance, 2)
	assert.equal(wallet({entries: [...run('2026-01-01', 15), ...run('2026-03-01', 15)]}).balance, 0)
})

test('wallets are isolated by habit', () => {
	assert.equal(wallet({entries: run('2026-01-01', 60)}).balance, 2)
	assert.equal(wallet({entries: []}).balance, 0)
})

test('spending saves a usage date, deducts one, and survives reconstruction', () => {
	const next = updateHabitDay({entries: run('2026-01-01', 60)}, '2026-03-02', 'joker', today)
	assert.deepEqual(next.jokerUses, ['2026-03-02'])
	const reloaded = JSON.parse(JSON.stringify(next))
	assert.equal(wallet(reloaded).balance, 1)
	assert.equal(wallet(reloaded).used, 1)
})

test('cannot spend an unearned Joker or borrow a reward from the future', () => {
	assert.throws(() => updateHabitDay({entries: []}, '2026-01-01', 'joker', today), /No Joker/)
	assert.throws(() => updateHabitDay({entries: run('2026-01-01', 60)}, '2025-12-31', 'joker', today), /No Joker/)
	assert.throws(() => updateHabitDay({entries: run('2026-01-01', 30)}, '2026-11-16', 'joker', today), /future/)
})

test('blocks adjacent usage in both directions even with a stacked balance', () => {
	const fm = {entries: run('2026-01-01', 90), jokerUses: ['2026-04-03']}
	assert.match(jokerUseError(fm, '2026-04-02', today), /consecutive/)
	assert.match(jokerUseError(fm, '2026-04-04', today), /consecutive/)
	assert.equal(jokerUseError(fm, '2026-04-05', today), '')
})

test('rejects backdated spending that would overspend a later saved use', () => {
	const fm = {entries: run('2026-01-01', 30), jokerUses: ['2026-02-05']}
	assert.throws(() => updateHabitDay(fm, '2026-02-01', 'joker', today), /No Joker/)
})

test('Joker bridges a streak but does not count as a completed day', () => {
	const fm = {
		entries: [...run('2026-01-01', 30), ...run('2026-02-01', 29)],
		jokerUses: ['2026-01-31'],
	}
	assert.equal(wallet(fm).earned, 1)
	fm.entries.push('2026-03-02')
	assert.equal(wallet(fm).earned, 2)
	assert.deepEqual(wallet(fm).errors, [])
})

test('clicking a Joker refunds it and clears the marker', () => {
	const next = updateHabitDay({entries: run('2026-01-01', 30), jokerUses: ['2026-02-01']}, '2026-02-01', 'cycle', today)
	assert.deepEqual(next.jokerUses, [])
	assert.equal(wallet(next).balance, 1)
})

test('history edits cannot revoke earnings backing an existing use', () => {
	const fm = {entries: run('2026-01-01', 30), jokerUses: ['2026-02-01']}
	assert.throws(() => updateHabitDay(fm, '2026-01-30', 'cycle', today), /invalidate/)
	assert.equal(fm.entries.length, 30)
})

test('skip days and maxGap protect milestone progress without adding to it', () => {
	const entries = [...run('2026-01-01', 15), ...run('2026-01-17', 15)]
	assert.equal(wallet({entries}).earned, 0)
	assert.equal(wallet({entries, skips: ['2026-01-16']}).earned, 1)
	assert.equal(wallet({entries, maxGap: 1}).earned, 1)
})

test('normalizes duplicates and ignores invalid dates and future completions', () => {
	assert.deepEqual(normalizeDates(['2026-01-01', '2026-01-01', 'bad', '2026-02-30', null]), ['2026-01-01'])
	assert.equal(wallet({entries: [...run('2026-11-01', 30), '2026-11-01'], skips: 'invalid'}).earned, 0)
})

test('preserves the existing done/skip/empty cycle and unrelated frontmatter', () => {
	let fm = {entries: [], title: 'Reading', color: 'red'}
	fm = updateHabitDay(fm, '2026-01-01', 'cycle', today)
	assert.deepEqual(fm.entries, ['2026-01-01'])
	fm = updateHabitDay(fm, '2026-01-01', 'cycle', today)
	assert.deepEqual(fm.entries, [])
	assert.deepEqual(fm.skips, ['2026-01-01'])
	fm = updateHabitDay(fm, '2026-01-01', 'cycle', today)
	assert.deepEqual(fm.skips, [])
	assert.equal(fm.title, 'Reading')
	assert.equal(fm.color, 'red')
})

test('spending replaces a skip but rejects completed days', () => {
	const fm = {entries: run('2026-01-01', 30), skips: ['2026-02-01']}
	assert.throws(() => updateHabitDay(fm, '2026-01-30', 'joker', today), /completed/)
	const next = updateHabitDay(fm, '2026-02-01', 'joker', today)
	assert.deepEqual(next.skips, [])
	assert.deepEqual(next.jokerUses, ['2026-02-01'])
})

test('invalid manually edited usage is reported and can be removed', () => {
	const fm = {entries: [], jokerUses: ['2026-02-01']}
	assert.equal(wallet(fm).errors.length, 1)
	assert.deepEqual(wallet(updateHabitDay(fm, '2026-02-01', 'cycle', today)).errors, [])
})
