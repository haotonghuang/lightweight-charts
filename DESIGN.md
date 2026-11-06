# Design

## Source of truth
Status: Active. Date: 2026-11-05. Surface: `es-research` local ES history viewer and personal setup encyclopedia.
Evidence: existing `index.html`, `app.js`, `server.py`, and `README.md`; no mockups or browser screenshot baselines exist. The user confirmed RTH 09:30–16:15 New York wall time, previous two RTH sessions, and the selected day's first 24 five-minute bars.

## Brand
Quiet, precise research tool. Preserve the existing dark chart, green/red candles, and TradingView attribution. Avoid decoration that competes with price action.

## Product goals
Load an independent local CSV, inspect EMA20/ADR8/ABR8, count RTH bars, replay without future prices, and review the ES open with context. Success means reproducible session selection and correct historical values. Live feeds, execution, and a backtest engine are out of scope.

## Personas and jobs
An ES trader reviews the first two RTH hours, compares prior sessions, and practices reading candles one at a time on a desktop browser.

## Information architecture
One page with three modes: history, replay, and opening review. Date/session controls precede the chart. Replay transport appears only in replay mode. Opening review selects a single trading date and fixes five-minute RTH bars. OHLC, ADR8, ABR8, bar range (high minus low), absolute body size, and daily opening gap remain visible in a readout strip immediately above the chart.

## Design principles
The collapsible 阿布图表百科 sidebar shares the existing chart instance. Setup categories contain background and entry rationale; reusable tags describe adverse and micro conditions. Cases identify the signal candle as `YYYY-MM-DD bar N`, with multiple setups, tags and optional free notes. Do not require repeated background/rationale fields or actual execution data. A selected candle enables capture with an explicit signal label. Setup/tag creation and renaming, case editing/deletion, AND/OR tag filtering, previous/next navigation, and JSON backup/restore belong in the sidebar.

Case navigation retains filters and list scroll, restores saved interval/session/price settings, and highlights the exact signal timestamp with surrounding context. Reuse loaded data when its context matches; otherwise reload into the same chart. Last selection wins during rapid navigation. Missing data, data-source mismatches and adjustment revisions produce explicit messages rather than silent substitutions. Case records live in a local SQLite database managed by the Python server, independently of browser-local drawings. Practice mode and screenshot attachments are deferred.

Keep the first bar of the target RTH session at the horizontal midpoint in opening review, with approximately 24 candles on either side in the initial viewport. Retain both prior sessions in the dataset so zoom and pan can reveal them. A separate range pane keeps point-valued ADR/ABR readable alongside the price pane. Every third RTH bar carries its session number. A small signed gap marker appears above each RTH opening candle; the readout provides points and percent relative to the prior RTH close, and a toggle hides markers. Replay renders only revealed bars, markers, and indicator values; precomputed future records never enter chart series or hover lookup.

## Visual language
Desktop uses a viewport-height chart workspace: a single compact toolbar, a slim utility row with display/help popovers, a two-line hover readout, a flexible chart, and a small status/attribution footer. Avoid a separate title block and always-visible checkbox or help sections. Price pane receives seven shares of height to the range pane's one; retain draggable pane resizing.

Reuse background `#101722`, controls `#1d2a3b`, borders `#41546d`, text `#dbe5f1`, and primary blue `#2966c7`. EMA is amber, ADR blue, ABR purple. Use system fonts, compact wrapping controls, subtle borders, and no ornamental imagery or animation.

## Components
The case editor includes inline name inputs for creating setups and tags, with “添加并选中” buttons and Enter support. Creation selects the new option for that draft and preserves notes, existing choices, and the captured signal anchor. Reuse an existing same-name option rather than creating duplicates. The management section remains available for renaming and descriptions.

Drawing tools: right-extending trend ray (two anchors), horizontal support/resistance (one), measured move (A/B/C with target C+(B-A)), and Fibonacci retracement (two). Anchor placement and endpoint edits snap to the nearer high or low of the bar under the pointer; future whitespace remains free for projections. Fibonacci decimal ratios are editable, saved as defaults, and can update a selected retracement with undo. Parallel channels are excluded by user request. Use a compact tool select and undo/redo buttons in the utility row; appearance, selected-item editing, deletion and JSON import/export live in a popover. The pinned drawing library is vendored for offline use. Store drawings as time/price anchors with versioned local browser persistence; replay uses its own scope and hides annotations created after the revealed cursor. Imported content must be validated before replacing current annotations; storage errors must not break the price chart.

Reuse native date inputs, selects, and buttons. Add mode selector, RTH/session selector, replay transport and speed, indicator visibility toggles, live status, indicator readout, and an opening-centering action. Tokens and page styles live in `es-research/index.html`.

## Accessibility
Target WCAG 2.2 AA for controls and text. Every input has a label; status uses `role=status`; native focus rings remain visible. Replay supports Space and Right Arrow outside form controls. No automatic playback on load. Values and text labels supplement color.

## Responsive behavior
The encyclopedia is a roughly 320px independently scrolling sidebar beside the chart on desktop; on narrow screens it stacks above the chart with bounded height. Closing it returns the width to the chart. All new controls use labels and keyboard focus styles; user text is rendered as text.

Controls wrap on narrow screens. Desktop chart fills the remaining viewport height using flex layout with a 200px minimum; mobile returns to document scrolling with a 65vh chart and 320px minimum. Chart width follows the full container, without the previous 1700px cap. Readouts wrap without horizontal page overflow. Desktop remains the primary review surface.

## Interaction states
Disable loading and replay controls while a request is pending. Abort stale requests and clear stale chart values on new loads. Show explicit empty/error states, history shortfalls, and missing indicator history. Parameter changes pause replay and require reloading. Playback pauses at the last available bar.

## Content voice
Concise Chinese labels. Use points for ranges, RTH for the specified day session, and explicitly explain that daily range excludes the current day. Never describe data-derived sessions as an exchange holiday calendar.

## Implementation constraints
Cache daily aggregated market bars within the current data index, bounded by 200,000 bars and 1,024 day entries. Keep source, interval, session, adjustment and roll revision boundaries explicit; enrich request-local copies with the original warmup window. A changed CSV requires re-indexing before further queries. Cache reuse must preserve exact OHLCV, indicator, bar-count and gap results and replay concealment.

RTH is now 09:30 inclusive to 16:15 exclusive (81 five-minute slots). Gap uses the prior RTH final close, normally the 16:14 minute. Roll adjustment is estimated additive back-adjustment based on narrowly scoped candidate midnight discontinuities, with raw data retained, visible audit records, override support, and distinct drawing scopes per adjusted price revision. Absolute replay prices in adjusted mode use the full-file adjusted snapshot.

Use the existing vendored Lightweight Charts 5.2.1, plain JavaScript, and Python standard library. Keep the price viewer build-free; the user-authorized drawing feature may vendor a pinned MIT drawing plugin, with license and provenance. No runtime CDN dependency. CSV timestamps retain their original New York wall time. Indicators warm up before the display window; replay values must not depend on unrevealed candles. Verify formulas and selection with synthetic fixtures and interaction tests; document browser validation gaps if a browser is unavailable.

## Open questions
No blocking product questions. Holiday/early-close status is inferred from available source rows; a complete exchange calendar and missing source data remain outside this iteration.
