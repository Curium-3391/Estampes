# Workbench (Graph + scientific calculator in one widget)

Since 0.19.0 the Visual Surface widget is a small window manager. The canvas (photo, Graph objects, marks) is one panel; the SymPy calculator ([CAS](CAS.md)) is another. Both stay on screen inside the ChatGPT MCP App: nothing opens a pop-out window or a second page. Server-side state and tools are in [SURFACES.md](SURFACES.md).

## Using it

- Alone, the canvas looks as before and offers **＋ 科學計算機** (enabled once the user has enabled the CAS module in the Store).
- With two panels open, the widget switches to windows: drag a title bar to move, drag the right/bottom edges or the lower-right corner to resize, `☰` for dock presets (left, right, top, bottom, floating, bring to front), `–` to minimise to a chip, `▢` to maximise inside the workbench. Closing a calculator keeps its notebook.
- Keyboard: focus a title bar, then **Alt+Arrows** move it and **Alt+Shift+Arrows** resize it. Every menu item and button is reachable by Tab.
- Phones (< 600 px wide) get **tabs**, one panel at a time, with ◀ ▶ to reorder. Tablets (600–899 px) and desktops (≥ 900 px) have their own saved layouts; rotating the device switches layout and never overwrites the other ones.
- Positions snap to neighbours and to the edges and are clamped so a panel can never be lost off screen. **重設版面** puts the panels back.

## Calculator panel

While a calculation runs, **停止** appears next to **計算**. It cancels that job in the service (the worker process is killed); nothing is written, so no cell or error cell is left and the notebook revision does not change. `calculate` and `recompute` take an optional `job` id (8-32 hex characters) for this; the widget-only tool `surface_cas_cancel {job}` cancels it. A cancel that arrives before the job starts still wins.

Choose an operation (evaluate, simplify, expand, factor, differentiate, integrate, limit, series, solve, solve system, numeric solve, substitute, matrix, sum, product, ...), type text or switch to LaTeX, press **計算** (Enter calculates a one-line expression, Shift+Enter inserts a newline, Ctrl/⌘+Enter always calculates; IME composition is never interrupted). Symbol keys are optional.

Each history cell shows the input, the exact result typeset as MathML (from the LaTeX SymPy produced), the plain text form, an approximate value when there is one, warnings and its status (exact, approximate, complex, conditional, partial, undefined). Actions: **畫在 Graph** (only exact/approximate real single-variable results), **重算**, **修改**, copy LaTeX, copy text. A Graph object made from a cell is linked to it; changing a definition or assumption marks affected cells and links **stale** until recomputed. Variables, functions and assumptions live in the panel's "變數、函數與假設" section.

## Safety

- The widget builds everything with `createElement`/`textContent`; server, module or user text never reaches `innerHTML`. The browser test feeds `<img onerror=...>` as an expression and checks nothing runs.
- Panels are data (`estampes.panel/1`): a manifest names a built-in renderer and cannot carry HTML, script or CSS.
- Layout changes carry the revision they were based on and an idempotency key, are serialised, and retry once on top of a newer revision.

## Tests

`tests/workbench-e2e.test.js` starts the real server and the real SymPy service, loads the real widget in Chromium through a fake host that relays `tools/call` to MCP, and checks: solo canvas, opening the calculator, both panels visible without overlap, a real derivative typeset as MathML, hostile input as inert text, plotting into Graph with a link, drag saved to the surface, Alt+Arrow, the phone tab layout with no horizontal scroll, and no page errors. CI runs it with the runner's Chrome and uploads screenshots. It needs `playwright` or `playwright-core` and `python3` with SymPy; it skips otherwise.

**Not covered:** a live ChatGPT host (iframe sandbox, host CSP, host-specific postMessage behaviour). That check has not been executed. Manual script: enable Graph and Scientific CAS in the Store; ask for `sin(x)` plotted; press ＋ 科學計算機; differentiate `sin(x^2)`; press 畫在 Graph; drag the calculator; rotate or open on a phone and check the tabs; confirm the model can read the result with `get_surface_state`.

## Limits

- The Graph panel and the photo canvas share one viewport; a second independent Graph viewport is not implemented.
- Links refresh only when you press 重算 or 更新 Graph 圖形 (no auto-refresh policy yet). Editing a plot directly does not mark its link stale.
- `.estampes` export of notebooks and surfaces is not implemented.
