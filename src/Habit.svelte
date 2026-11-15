<script>
	import {debugLog, isValidCSSColor} from './utils'

	import {onDestroy} from 'svelte'
	import {Notice, parseYaml, TFile} from 'obsidian'
	import {getJokerState, normalizeDates, updateHabitDay} from './jokers.mjs'
	import {getDayOfTheWeek} from './utils'
	import {addDays, differenceInCalendarDays, parseISO, format} from 'date-fns'

	export let app
	export let name
	export let path
	export let dates
	export let debug
	export let pluginName
	export let userSettings
	export let globalSettings

	let entries = []
	let skips = [] // days that don't count towards a streak but don't break it either
	let jokerUses = []
	let choosingJoker = false
	let frontmatter = {}
	let habitName = name
	let customStyles = ''
	let savingChanges = false // this helps the file change listner know if we made a change. if not, it reloads the data for the habit
	let jokerState = getJokerState({})
	// The parent refreshes dates at midnight, when future entries may become eligible.
	$: if (dates) jokerState = getJokerState({...frontmatter, entries, skips, jokerUses})
	$: protectedDays = [...new Set([...skips, ...jokerUses])].sort()

	// Reactive color resolution - updates whenever frontmatter, userSettings, or globalSettings change
	$: {
		const resolvedColor =
			frontmatter.color || userSettings.color || globalSettings.defaultColor
		if (resolvedColor && isValidCSSColor(resolvedColor)) {
			customStyles = `--habit-bg-ticked: ${resolvedColor}`
		} else {
			customStyles = ''
		}
	}
	$: showStreaks =
		userSettings.showStreaks !== undefined
			? userSettings.showStreaks
			: globalSettings.showStreaks

	$: renderedDates = (() => {
		const maxGap = Number(frontmatter.maxGap) || 0
		const entrySet = new Set(entries)
		const skipSet = new Set(protectedDays)
		const jokerSet = new Set(jokerUses)
		const gapStyle =
			userSettings.gapStyle !== undefined
				? userSettings.gapStyle
				: globalSettings.gapStyle

		const shiftDate = (date, amount) =>
			format(addDays(parseISO(date), amount), 'yyyy-MM-dd')

		// Missed days strictly between two dates. Skipped days are not missed.
		const missedBetween = (from, to) =>
			differenceInCalendarDays(parseISO(to), parseISO(from)) -
			1 -
			protectedDays.filter((s) => s > from && s < to && !entrySet.has(s)).length

		// A non-ticked date belongs to a streak when it sits between two entries
		// whose missed days are within maxGap, or when it is part of an unbroken
		// run of skipped days right after an entry.
		const isBridged = (date) => {
			let prev = null
			let next = null
			for (const entry of entries) {
				if (entry < date) prev = entry
				else if (entry > date) {
					next = entry
					break
				}
			}
			if (!prev) return false
			if (next && missedBetween(prev, next) <= maxGap) return true
			return skipSet.has(date) && missedBetween(prev, date) === 0
		}

		const inStreak = (date) => entrySet.has(date) || isBridged(date)

		// Pass 1 — mark each date
		const days = dates.map((date) => {
			const ticked = entrySet.has(date)
			return {
				date,
				ticked,
				skipped: !ticked && skipSet.has(date),
				joker: jokerSet.has(date),
				gap: !ticked && isBridged(date),
				deadline: false,
				title: '',
				streakStart: false,
				streakEnd: false,
				streakCount: 0,
				classes: '',
			}
		})

		// Pass 2 — identify streak boundaries and counts
		let streakStartIdx = -1
		for (let i = 0; i <= days.length; i++) {
			const inRun = i < days.length && (days[i].ticked || days[i].gap)
			if (inRun && streakStartIdx === -1) {
				streakStartIdx = i
			} else if (!inRun && streakStartIdx !== -1) {
				// Streak just ended at i-1
				const endIdx = i - 1
				const firstDate = days[streakStartIdx].date
				const lastDate = days[endIdx].date

				// Only round off ends that fall inside the visible range
				if (!inStreak(shiftDate(firstDate, -1))) {
					days[streakStartIdx].streakStart = true
				}
				if (!inStreak(shiftDate(lastDate, 1))) {
					days[endIdx].streakEnd = true
				}

				// Count: walk backward through entries from the last entry in this streak
				let anchorIdx = -1
				for (let j = entries.length - 1; j >= 0; j--) {
					if (entries[j] <= lastDate) {
						anchorIdx = j
						break
					}
				}
				let count = 0
				if (anchorIdx !== -1) {
					count = 1
					for (let j = anchorIdx; j > 0; j--) {
						if (missedBetween(entries[j - 1], entries[j]) > maxGap) break
						count++
					}
				}

				days[endIdx].streakCount = count

				streakStartIdx = -1
			}
		}

		// Pass 3 — ghost dot on the last day of the gap (deadline to keep streak alive).
		// Skipped days push the deadline back.
		if (maxGap > 0 && entries.length > 0) {
			const today = format(new Date(), 'yyyy-MM-dd')
			let deadlineDate = entries[entries.length - 1]
			let missed = 0
			while (missed <= maxGap) {
				deadlineDate = shiftDate(deadlineDate, 1)
				if (!skipSet.has(deadlineDate)) missed++
			}
			if (deadlineDate >= today) {
				const ghostDay = days.find((d) => d.date === deadlineDate)
				if (ghostDay && !ghostDay.ticked) {
					ghostDay.deadline = true
				}
			}
		}

		// Build classes
		for (const day of days) {
			const cls = [
				'habit-tracker__cell',
				`habit-tracker__cell--${getDayOfTheWeek(day.date)}`,
				'habit-tick',
			]
			if (day.ticked) cls.push('habit-tick--ticked')
			if (day.skipped) cls.push('habit-tick--skipped')
			if (day.joker) cls.push('habit-tick--joker')
			if (showStreaks) {
				const inStrk = day.ticked || day.gap
				if (inStrk) cls.push('habit-tick--streak')
				if (day.skipped && day.gap) {
					cls.push('habit-tick--streak-skip')
				} else if (day.gap && !day.ticked) {
					cls.push('habit-tick--streak-gap')
					cls.push(gapStyle === 'faded' ? 'habit-tick--gap-faded' : 'habit-tick--gap-default')
				}
				if (day.streakStart) cls.push('habit-tick--streak-start')
				if (day.streakEnd) cls.push('habit-tick--streak-end')
				if (day.streakCount > 0 && !day.streakEnd)
					cls.push('habit-tick--streak-count')
				if (day.deadline) cls.push('habit-tick--streak-deadline')
			}
			day.classes = cls.join(' ')
		}

		return days
	})()

	const init = async function () {
		debugLog(`Loading habit ${habitName}`, debug, undefined, pluginName)

		const getFrontmatter = async function (path) {
			const file = app.vault.getAbstractFileByPath(path)

			if (!file || !(file instanceof TFile)) {
				debugLog(
					`No file found for path: ${path}`,
					debug,
					undefined,
					pluginName,
				)
				return {}
			}

			try {
				return await app.vault.read(file).then((result) => {
					const frontmatter = result.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]

					if (!frontmatter) {
						return {entries: []}
					}
					const fmParsed = parseYaml(frontmatter) || {}
					if (fmParsed['entries'] == undefined) {
						fmParsed['entries'] = []
					}

					return fmParsed
				})
			} catch (error) {
				debugLog(
					`Error in habit ${habitName}: error.message`,
					debug,
					undefined,
					pluginName,
				)
				return {}
			}
		}

		frontmatter = await getFrontmatter(path)
		debugLog(`Frontmatter for ${path} ↴`, debug)
		debugLog(frontmatter, debug)
		entries = normalizeDates(frontmatter.entries)
		skips = normalizeDates(frontmatter.skips)
		jokerUses = normalizeDates(frontmatter.jokerUses)
		habitName = frontmatter.title || habitName

		debugLog(`Habit "${habitName}": Found ${entries.length} entries`, debug)
		debugLog(entries, debug, undefined, pluginName)
	}

	const toggleHabit = async function (date) {
		if (savingChanges) return
		const file = app.vault.getAbstractFileByPath(path)
		if (!file || !(file instanceof TFile)) {
			new Notice(`${pluginName}: file missing while trying to toggle habit`)
			return
		}

		savingChanges = true
		try {
			await app.fileManager.processFrontMatter(file, (fm) => {
				const next = updateHabitDay(fm, date, choosingJoker ? 'joker' : 'cycle')
				fm.entries = next.entries
				for (const key of ['skips', 'jokerUses']) {
					if (next[key].length) fm[key] = next[key]
					else delete fm[key]
				}
			})
			choosingJoker = false
			await init()
		} catch (error) {
			new Notice(`${pluginName}: ${error.message}`)
		} finally {
			savingChanges = false
		}
	}

	init()

	let tooltipEl = null

	function showTooltip(e, day) {
		if (!day.deadline) return
		hideTooltip()
		const rect = e.currentTarget.getBoundingClientRect()

		tooltipEl = document.body.createDiv({
			cls: 'ht21-tooltip',
			text: 'Last day to keep your streak alive!',
		})
		tooltipEl.style.left = `${rect.left + rect.width / 2}px`
		tooltipEl.style.top = `${rect.top - 4}px`
	}

	function hideTooltip() {
		if (tooltipEl) {
			tooltipEl.remove()
			tooltipEl = null
		}
	}

	const modifyRef = app.vault.on('modify', (file) => {
		if (file.path === path) {
			if (!savingChanges) {
				init()
			}
		}
	})

	onDestroy(() => {
		app.vault.offref(modifyRef)
		hideTooltip()
	})
</script>

<svelte:window on:keydown={(event) => { if (event.key === 'Escape') choosingJoker = false }} />

<!-- <div bind:this={rootElement}> -->
<div
	class="habit-tracker__row"
	style={customStyles}
>
	<div class="habit-tracker__cell--name habit-tracker__cell">
		<a
			href={path}
			aria-label={path}
			class="internal-link">{habitName}</a
		>
		<button
			class="habit-joker-balance"
			class:habit-joker-balance--active={choosingJoker}
			aria-pressed={choosingJoker}
			disabled={savingChanges || (!choosingJoker && jokerState.balance === 0)}
			title={choosingJoker ? 'Select a day to use one Joker. Click here or press Escape to cancel.' : `${jokerState.balance} Jokers available · ${jokerState.earned} earned · ${jokerState.used} used. Earn one every 30 completed streak days. Click to choose a day.`}
			on:click={() => choosingJoker = !choosingJoker}
		>Joker {jokerState.balance}</button>
		{#if jokerState.errors.length}
			<span class="habit-joker-warning" title={jokerState.errors.map((error) => `${error.date}: ${error.reason}`).join('\n')}>⚠</span>
		{/if}
	</div>
	{#if renderedDates.length}
		{#each renderedDates as day}
			<div
				class={day.classes}
				role="button"
				tabindex="0"
				aria-label={`${habitName}, ${day.date}: ${day.joker ? 'Joker used. Activate to undo and refund.' : day.ticked ? 'Done' : day.skipped ? 'Skipped' : 'Empty'}${choosingJoker ? '. Use Joker on this day' : ''}`}
				title={day.joker ? `${day.date}: Joker used (click to undo and refund)${showStreaks && day.streakCount > 1 ? ` · Streak: ${day.streakCount}` : ''}` : choosingJoker ? `${day.date}: Use one Joker` : day.date}
				aria-disabled={savingChanges}
				ticked={day.ticked}
				on:mouseenter={(e) => showTooltip(e, day)}
				on:mouseleave={hideTooltip}
				on:click={() => toggleHabit(day.date)}
				on:keydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault()
						toggleHabit(day.date)
					}
				}}
			>
				<span
					class="habit-tick__inner"
					>{#if day.joker}J{:else if showStreaks && day.streakEnd && day.streakCount > 1}{day.streakCount}{/if}</span>
			</div>
		{/each}
	{/if}
</div>
