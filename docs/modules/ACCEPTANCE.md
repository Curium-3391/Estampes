# External-developer acceptance

Can someone who never worked on Estampes build a module from the public guides alone? This page is the test protocol, the three cases, and what the last run found.

Reference: [Module quick start](QUICKSTART.md), [Testing modules](TESTING.md), [Distributing modules](DISTRIBUTION.md), [Modules](../MODULES.md).

## Rules

- Start from a clean machine or container with Node 22 (and clang with `wasm-ld` for the WebAssembly case): `git clone`, `npm ci`, nothing else.
- Read only the public documents above and the files under `examples/modules/`. Do not read `src/`, do not ask the maintainers, do not change any file outside your own module folder.
- Each case ends with: `test` passes, the package is signed, published through a package source (or sent as a file), trusted, synced, installed (user consent and `approve <planId>`), enabled, and run, with the result visible on a canvas.
- Write down every place you got stuck, guessed, or had to read code, with the document and section. Those are the findings.

## The three cases

| Case | Runtime | Task | Done when |
| --- | --- | --- | --- |
| 1. Markers | declarative | Numbered markers with labels at any number of points of any picture | one ring, one number and one label per point; a point outside 0..1 is refused and changes nothing |
| 2. Line fit | wasm | A least-squares line through measured points, with slope, intercept and R squared | the numbers match an independent computation; axes, points, line and a card are drawn; unfittable input fails with a readable message |
| 3. Keywords | http | Send a text to an external analysis service and show its summary and keywords | `test` exercises the reply mapping offline (good reply, error status, changed reply format); a real call shows the summary on the canvas and the keywords in a card; the API key never appears in the audit log |

Reference solutions: `examples/modules/markers`, `examples/modules/linefit` (C source and its build line), `examples/modules/keywords`. `tests/module-acceptance.test.js` runs all three from a clean folder through the whole sequence on every CI run; the http case there talks to a fake https service.

## Recording a run

Copy this into an issue titled "Module acceptance run":

```
Who: (never contributed to Estampes? yes/no)   Date:   Estampes commit:
Environment: OS, Node version, clang version
Case 1 markers:  minutes:   reached: test / pack / source / install / run / canvas
Case 2 linefit:  minutes:   reached: ...
Case 3 keywords: minutes:   reached: ...    real service used: (host, or "none")
Where I got stuck (document, section, what I expected, what happened):
Where I had to read code or guess:
```

## Runs

### 2026-11-16: internal clean-room run (not an external developer)

Done by the maintainers' AI assistant in a fresh clone, building the three modules from the guides. This is **not** the acceptance the protocol asks for: the person doing it knew the code, so it finds gaps in the documents but cannot show that an outsider succeeds. An external run is still open.

Result: all three cases reached a result on the canvas through the package-source route, after the fixes below. The http case ran against a fake https service; no real analysis service was called, and no ChatGPT or Claude host was used (install and run went through the module host directly, as `tests/module-acceptance.test.js` does).

Gaps found, and what was done:

| # | Gap | Fixed by |
| --- | --- | --- |
| 1 | `module test` did not exercise the http response mapping, so a module could pass and still fail on the first real reply | `mockResponse` in examples, run through the real mapping; missing `$response` paths are errors ([HTTP specifics](TESTING.md#http-specifics)) |
| 2 | Examples could not state what a call should return, so a numeric module's results were untested | `expect` (operation count, a `data` pattern with float tolerance, `summary`, or the expected `error`) |
| 3 | `init` had no http starter | `init --runtime http` |
| 4 | A template could not make one object per item of a list (markers for N points, card rows for N keywords) | `$each` / `$item` / `$index` ([Templates](../MODULES.md#templates)) |
| 5 | Numbers could not go into text fields such as info-card values | `"as": "string"` |
| 6 | A WebAssembly module could not refuse a call with a message; only a trap, which reads as a crash | reply `{"error": "..."}` |
| 7 | How to refer to an object created earlier in the same batch was unclear (`ref` vs `$ref`) | documented: `"ref": "ax"`, then `"$ax"` |
| 8 | Object properties (colours, `style`, text `size`, units of `r`) were not listed anywhere public | property table in [Modules](../MODULES.md#scene-operations-estampesscene-ops1) |
| 9 | What the WebAssembly request contains (`canvas`) and how large it can be was not stated, and there was no JSON help for freestanding C | documented; `linefit.c` has a reusable reader and writer |
| 10 | Publishing meant sending files and keys by hand to each administrator | package sources and URL import ([Distributing modules](DISTRIBUTION.md)) |

Open, not fixed here:

- Templates cannot calculate, so a marker's label sits on its ring unless the caller passes a second position. A small arithmetic placeholder would fix it.
- A declarative http module cannot send the canvas image (an OCR or image-analysis service on the picture itself needs a built-in module today).
- Step 6 of the quick start needs ChatGPT or copying a test file; a CLI command that installs into a scratch server and runs one capability, printing the resulting objects, would make "run it" possible offline for an outsider.
- A real call from a developer laptop to their own local service is impossible by design (egress only reaches public https hosts); authors must test against a deployed service or rely on `mockResponse`.
