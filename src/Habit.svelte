<script>
	import {debugLog, isValidCSSColor} from './utils'

	import {onDestroy} from 'svelte'
	import {parseYaml, TFile} from 'obsidian'
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
	let frontmatter = {}
	let habitName = name
	let customStyles = ''
	let savingChanges = false // this helps the file change listner know if we made a change. if not, it reloads the data for the habit

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
		const skipSet = new Set(skips)
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
			skips.filter((s) => s > from && s < to && !entrySet.has(s)).length

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
			const file = this.app.vault.getAbstractFileByPath(path)

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
				return await this.app.vault.read(file).then((result) => {
					const frontmatter = result.split('---')[1]

					if (!frontmatter) {
						return {entries: []}
					}
					const fmParsed = parseYaml(frontmatter)
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
		entries = frontmatter.entries
		entries = entries.sort()
		skips = Array.isArray(frontmatter.skips)
			? [...new Set(frontmatter.skips)].sort()
			: []
		habitName = frontmatter.title || habitName

		debugLog(`Habit "${habitName}": Found ${entries.length} entries`, debug)
		debugLog(entries, debug, undefined, pluginName)
	}

	const toggleHabit = function (date) {
		const file = this.app.vault.getAbstractFileByPath(path)
		if (!file || !(file instanceof TFile)) {
			new Notice(`${pluginName}: file missing while trying to toggle habit`)
			return
		}

		// Click cycle: empty → ticked → skipped → empty
		let newEntries = [...entries]
		let newSkips = [...skips]
		if (entries.includes(date)) {
			newEntries = newEntries.filter((e) => e !== date)
			newSkips.push(date)
		} else if (skips.includes(date)) {
			newSkips = newSkips.filter((s) => s !== date)
		} else {
			newEntries.push(date)
		}
		entries = newEntries.sort()
		skips = newSkips.sort()

		savingChanges = true

		this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter['entries'] = entries
			if (skips.length) {
				frontmatter['skips'] = skips
			} else {
				delete frontmatter['skips']
			}
		})
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
				console.log('oh shit, i was modified')
				init()
			}
			savingChanges = false
		}
	})

	onDestroy(() => {
		app.vault.offref(modifyRef)
		hideTooltip()
	})
</script>

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
	</div>
	{#if renderedDates.length}
		{#each renderedDates as day}
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<div
				class={day.classes}
				ticked={day.ticked}
				on:mouseenter={(e) => showTooltip(e, day)}
				on:mouseleave={hideTooltip}
				on:click={() => toggleHabit(day.date)}
			>
				<span
					class="habit-tick__inner"
				>{#if showStreaks && day.streakEnd && day.streakCount > 1}{day.streakCount}{/if}</span>
			</div>
		{/each}
	{/if}
</div>
