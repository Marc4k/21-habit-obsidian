import {addDays, differenceInCalendarDays, format, isValid, parseISO} from 'date-fns'

export const shiftDate = (date, amount) =>
	format(addDays(parseISO(date), amount), 'yyyy-MM-dd')

export function normalizeDates(value) {
	return [...new Set((Array.isArray(value) ? value : []).filter((date) =>
		typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
		isValid(parseISO(date)),
	))].sort()
}

// Rebuild the wallet from the habit's full history, never just the visible grid.
// Every streak earns at 30, 60, 90... completed days. Breaks reset progress only.
export function getJokerState(frontmatter, today = format(new Date(), 'yyyy-MM-dd')) {
	const entries = normalizeDates(frontmatter.entries).filter((date) => date <= today)
	const uses = normalizeDates(frontmatter.jokerUses)
	const entrySet = new Set(entries)
	const neutral = normalizeDates([...normalizeDates(frontmatter.skips), ...uses])
		.filter((date) => !entrySet.has(date))
	const maxGap = Math.max(0, Math.floor(Number(frontmatter.maxGap) || 0))
	const earnedDates = []
	let streak = 0
	let previous = null
	for (const date of entries) {
		const missed = previous === null ? 0 :
			differenceInCalendarDays(parseISO(date), parseISO(previous)) - 1 -
			neutral.filter((skip) => skip > previous && skip < date).length
		streak = previous === null || missed > maxGap ? 1 : streak + 1
		if (streak % 30 === 0) earnedDates.push(date)
		previous = date
	}

	const errors = []
	for (let i = 0; i < uses.length; i++) {
		const date = uses[i]
		let reason = ''
		if (date > today) reason = 'Jokers cannot be used on future days.'
		else if (entrySet.has(date)) reason = 'A completed day cannot also use a Joker.'
		else if (uses.includes(shiftDate(date, -1))) reason = 'Jokers cannot be used on two consecutive days.'
		else if (earnedDates.filter((earned) => earned < date).length <= i)
			reason = 'No Joker was available for this habit on that day.'
		if (reason) errors.push({date, reason})
	}
	return {
		earned: earnedDates.length,
		earnedDates,
		used: uses.length,
		balance: Math.max(0, earnedDates.length - uses.length),
		errors,
	}
}

export function jokerUseError(frontmatter, date, today) {
	const uses = normalizeDates(frontmatter.jokerUses)
	if (normalizeDates(frontmatter.entries).includes(date)) return 'A completed day cannot also use a Joker.'
	if (uses.includes(shiftDate(date, -1)) || uses.includes(shiftDate(date, 1)))
		return 'Jokers cannot be used on two consecutive days.'
	const candidate = getJokerState({...frontmatter, jokerUses: [...uses, date]}, today)
	return candidate.errors[0]?.reason || ''
}

// Called inside Obsidian's frontmatter transaction so multiple tracker views
// always spend against the latest saved wallet.
export function updateHabitDay(frontmatter, date, action = 'cycle', today) {
	let entries = normalizeDates(frontmatter.entries)
	let skips = normalizeDates(frontmatter.skips)
	let uses = normalizeDates(frontmatter.jokerUses)
	const removingJoker = uses.includes(date)
	if (removingJoker) {
		uses = uses.filter((day) => day !== date)
	} else if (action === 'joker') {
		const error = jokerUseError(frontmatter, date, today)
		if (error) throw new Error(error)
		uses.push(date)
		skips = skips.filter((day) => day !== date)
	} else if (entries.includes(date)) {
		entries = entries.filter((day) => day !== date)
		skips.push(date)
	} else if (skips.includes(date)) {
		skips = skips.filter((day) => day !== date)
	} else {
		entries.push(date)
	}
	const next = {...frontmatter, entries: entries.sort(), skips: skips.sort(), jokerUses: uses.sort()}
	const oldErrors = getJokerState(frontmatter, today).errors
	const newError = getJokerState(next, today).errors.find((error) =>
		!oldErrors.some((old) => old.date === error.date && old.reason === error.reason),
	)
	if (newError) throw new Error(`This change would invalidate the Joker on ${newError.date}. ${newError.reason}`)
	return next
}
