# Tutorial: plate-solve a night-sky photo

Goal: find where a photo of the sky points and see the named stars and objects on the canvas. Capability: **Optional** built-in module `org.estampes.astrometry`, using the external service [Astrometry.net](https://nova.astrometry.net). Reference: [Plate solving](../MODULES.md#plate-solving-orgestampesastrometry).

**Data leaves your server.** The module uploads the chosen image to Astrometry.net (marked private there) using your API key. Only enable it if that is acceptable for the pictures you use.

## Prerequisites

- A running server with **storage on** (the Docker default); the module reads the stored copy of the image. JPEG or PNG only.
- An Astrometry.net account and API key (profile page on nova.astrometry.net).
- A real photo of a star field. There is no bundled sample; a synthetic image cannot be solved. A wide-field photo with tens of stars works better than a single bright star. Optional hints (rough scale range or position) make solving faster.

## Administrator setup (once)

1. Store the key where the server runs. With Docker:

   ```sh
   echo "$KEY" | docker compose exec -T estampes node scripts/estampes-module.js secret set org.estampes.astrometry api_key
   docker compose exec estampes ls -l /data/modules/secrets.json
   ```

   Expected: `secret set` prints `Stored api_key for org.estampes.astrometry in …/secrets.json (mode 600)`, and the file exists with mode `-rw-------`. Do not rely on `secret status org.estampes.astrometry` for this module: that command reads the declared secrets of an *installed package*, and plate solving is built in, so it prints "No declared secrets … (or it is not installed)" even when the key is stored. The real test is the first solve: a missing key is reported by the job as "no key set".

2. In ChatGPT ask: *"Open the Estampes Store."* Find **Plate solving**, read the permissions it asks for (it sends images to an external host and can create a new canvas), and enable it. Enabling this module is a high-risk change, so the Store shows the exact command that approves the plan on the server; run it. **User confirmation** in the Store and **administrator approval** on the server are both required; GPT can prepare the change but cannot approve it ([Modules](../MODULES.md)).

## Success path

**1. Ask.** Attach the photo and write: *"Plate-solve this photo and show what is in the field."*

- Expected: GPT shows the canvas and starts a background job. It checks progress with `get_module_job` (status, progress). Solving usually takes from tens of seconds to a few minutes; it depends on Astrometry.net's queue, which Estampes does not control.

**2. Result.** When the job finishes, expected on the canvas: marks for the brightest named stars first, then deep-sky objects, with overlapping labels skipped; and an info card with the field centre (RA/Dec in degrees and hms/dms), field size, scale (arcsec per pixel), rotation and constellation tags, plus links to the result page, the WCS file and the Legacy Surveys sky browser.

- **Tool result:** the solution and the object names come from Astrometry.net and its catalogues.
- **Model inference:** anything GPT adds ("that bright star in the corner is probably a planet") is not part of the solution. Check it against the marks.
- **User confirmation:** compare two or three named stars with a sky chart before relying on the result.

**3. Context.** Ask for the sky position map. Expected: an all-sky drawing with the solved field outlined (`sky_position`, no network). It is approximate: it ignores distortion and flipping.

## Failure and degraded paths

Try one deliberately: attach `sample-material/sample-board.png` (the circuit-board picture) and ask for a plate solve.

- Expected: the job runs and **fails**; the failure says Astrometry.net could not solve it. No marks are added. This is the correct outcome for an image without stars.

Other failures, each reported by the job with its reason:

| Message says | Cause | Fix |
| --- | --- | --- |
| no key set / key refused | Secret missing or wrong | `secret set` again (check the file as above); refresh the key on nova.astrometry.net. |
| no stored copy of the image | Server runs without storage | Turn storage on (`ESTAMPES_STORAGE_DIR`). |
| unsupported format | Not JPEG or PNG | Convert and attach again. |
| module not enabled | Store plan not confirmed or not approved | Finish both steps under Administrator setup. |
| could not solve | Too few stars, too much blur, wrong scale | Add hints (scale range, rough position), use a sharper or wider photo. |
| (no message) job stays pending for a long time | Probably Astrometry.net's queue or an outage | Wait; ask GPT to check the job again; try later. Your canvas is unaffected. |

If the server restarts while a job runs, the job is shown as interrupted ("the server restarted while this was running; start it again"); ask again.

## Status

Not executed: a live ChatGPT conversation, and a real call to Astrometry.net from this documentation. The module's request handling is covered by automated tests (`tests/astrometry.test.js`) against a fake service. See [Compatibility](../COMPATIBILITY.md).
