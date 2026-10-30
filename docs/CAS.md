# Scientific CAS (SymPy)

`org.estampes.cas` is a built-in module. It computes with [SymPy](https://www.sympy.org) in a separate container (`cas-service/`), keeps results in notebooks and can draw them in Graph. GPT chooses the operation; **the result is only what SymPy returned**. An explanation written by the model is not a verified result.

## What it can do

| Group | Operations |
|---|---|
| Arithmetic | `evaluate` (exact rationals, radicals, complex numbers, `pi`, `e`, `I`, factorial, any precision up to 100 digits) |
| Algebra | `simplify`, `expand`, `factor`, `collect`, `cancel`, `apart`, `together`, `trigsimp`, `substitute` |
| Calculus | `differentiate` (order 1-10), `integrate` (indefinite shows `+ C`; definite with `lower`/`upper`), `limit` (one or two sided), `series`, `summation`, `product` |
| Equations | `solve` (real or complex domain, inequalities), `solve_system` (linear and non-linear), `nsolve` (needs a guess) |
| Matrices | `matrix` with `mode`: determinant, inverse, transpose, rank, rref, trace, eigenvalues, add, multiply (at most 8x8) |
| Notebook | `define` (variables, functions `f(x) = ...`, assumptions such as positive/real), `get_notebook`, `recompute` |
| Graph | `plot_result` |

Input is text (`sin(x^2)`, `x^2=4`, `2x`, `[[1,2],[3,4]]`, `|x|`, `5!`) or LaTeX (`\frac{1}{3}`, `\sqrt[3]{x}`, `\sin\left(x^{2}\right)`, `x^{2}`). Decimals are exact (`0.1` is `1/10`). Angle mode `deg` reads only numeric `sin/cos/tan` arguments as degrees (`sin(30)` is `1/2`); `sin(x)` is never rewritten, and `deg(30)` always works.

## Result status

`exact`, `approximate` (floats were involved), `complex`, `conditional` (solution sets that are not a finite list, piecewise), `partial` (SymPy found no closed form, the integral stays unevaluated) and `undefined` (NaN or complex infinity). Only `exact` and `approximate` real single-variable results can be plotted.

## Safety

* Text and LaTeX are parsed by a closed grammar (`cas-service/estampes_cas/parser.py`, `latex_in.py`). There is no attribute access, subscript, string, lambda or statement, and words such as `import`, `for`, `exec` are refused. The parser produces `estampes.math-ast/1`; the service validates that AST again and maps only allowlisted nodes and function names to SymPy. `eval`, `exec`, `sympify` and `parse_expr` are never called on user input, and results are serialised from an allowlist (unknown SymPy objects become read-only text).
* Limits: 4096 characters, depth 60, 2000 nodes, 300-digit integers, factorial up to 1000, power size, matrices 8x8, precision 100 digits, 8 s per calculation, 512 KB reply, 4 workers + a small queue. Lower any of them with `ESTAMPES_CAS_*` variables in `.env`.
* Each calculation runs in a forked child with `RLIMIT_CPU`, `RLIMIT_AS`, no file writes; the parent kills it at the wall-clock limit or on cancel.
* The container has `network_mode: none`, a read-only root, no capabilities, `no-new-privileges`, 128 processes and 2 GB. Its only channel is the Unix socket on the `cas-run` volume (mode 0600, peer uid 1000 = the Estampes user). It is never published and does not go through the outbound egress guard, which is unchanged.
* Residual risk: a SymPy bug that escapes the parser is limited by the container, not by Python itself.

## Notebooks, staleness and Graph links

A notebook (`nb:...`) holds cells (`cell:...`); each cell keeps its input, result (`cr:...`), error and links to Graph objects. Notebooks live in `<storage>/cas/notebooks` and survive restarts. Writes are atomic; `expectedRevision` refuses a stale writer; `idempotencyKey` returns the earlier result instead of calculating twice. A failed cell keeps its input.

Changing a definition or assumption marks every cell and link stale (never silently "current"). `recompute` refreshes them; `plot_result` with `object` redraws the existing plot instead of adding another. Refresh is manual in this version.

## Deployment

`docker compose up -d --build` starts both containers. `/healthz` shows `"cas": {"available": true, "engine": {...}}`. Stopping `cas` only disables calculations. Without Docker: `pip install -r cas-service/requirements.lock`, `cd cas-service && ESTAMPES_CAS_SOCKET=/tmp/cas.sock python -m estampes_cas`, and set the same variable for Estampes.

## Try it in ChatGPT

Enable "Scientific CAS" in the Store (it asks for the `cas.compute` permission), then:

* 「對 sin(x^2) 微分，然後把結果畫在 Graph 上。」
* "Solve x^2 - 4 = 0, then factor x^2 - 4."
* 「定義 f(x)=sin(x^2)，再算 f 的導數；之後把 f 改成 sin(2x)，並重新計算。」

Live-host (ChatGPT) testing of this release: not executed in CI.
