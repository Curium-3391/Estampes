# Workspaces (`estampes.workspace/1`)

A workspace puts any number of images (up to 24) in one canvas. Each image keeps its own marks, layers and coordinates, and the marks stay editable. Workspaces replace the old limit of one image plus one paired image, and they are how canvases are merged, split, moved, copied and linked without flattening anything into a picture.

## The pieces

| Piece | What it is | Id |
| --- | --- | --- |
| Asset | An image. Its bytes never change. | `img:<16 hex>`, the start of the SHA-256 of the file |
| Annotation set | The marks, layers, links and rejected claims drawn on one asset. Every image has its own set, which is what a single canvas or a paired view shows. A **copy** is a new set that records where it came from. | the imageId for the image's own set; `img:<hex>#c<hex>` for a copy |
| Workspace item | One set shown in one workspace, with its placement and an optional label | `wi-<n>`, unique within the workspace |
| Workspace | An ordered list of items, a name and a revision | `ws:<16 hex>` |

Marks are anchored to their asset, never to the workspace: every coordinate is normalized to the mark's own image (origin top-left), exactly as in [Visual protocol 2](PROTOCOL-V2.md). Moving, resizing, rotating or re-ordering an item changes only its placement. The widget maps between the two with the item's placement and its inverse.

Placement is in workspace units: `x`, `y` (top-left corner), `width` (default 1000; height follows the aspect ratio) and `rotation` (0, 90, 180 or 270 degrees). `layout: "auto"` fills rows (up to three items per row for three or fewer, otherwise about √n); setting `x`/`y` switches the workspace to `manual` and later items are placed to the right.

A mark is addressed by its item and its id. Ids only need to be unique within one set, so two images may both have a mark `g1`; tools ask for `item` when an id is ambiguous.

## Operations

All of them are non-destructive. None deletes an image, a set or a mark.

| Operation | Tool | What happens |
| --- | --- | --- |
| Create | `create_workspace` | A new workspace with new images, existing canvases (`canvases`, with their marks) or every image of existing workspaces or canvases (`from`). |
| Add, detach, arrange | `edit_workspace` | `add` items; `remove` detaches an item from this workspace only; `arrange` changes placement and label; `order`, `name`, `autoLayout`. |
| Merge | `merge_workspaces` | Brings the items of a source into a target. When the target is a canvas, a new workspace is created that shows the canvas's images first; the canvas itself is unchanged. |
| Split | `split_workspace` | Puts some items of a source into a new workspace. |
| Link | `mode: "link"` (default) | The target shows the **same** set. An edit in one place shows in every place the set is shown, including the original single or paired canvas. |
| Copy | `mode: "copy"` | The target gets a **new** set with the same marks, layers and rejected claims. Every copied mark carries `derivedFrom: { set, mark }` and the set carries `derivedFrom: { set, at }`. Later edits are independent. |
| Move | `removeFromSource: true` | Also removes the items from the source workspace. A single or paired canvas cannot be a move source: it always keeps its images. |
| Undo | `undo_workspace_change` | Every workspace a change touched goes back to its earlier state; a workspace the change created is archived. |

Links between marks of two items live with the two sets, in the same store a paired view uses. So a link made in a paired view shows in any workspace that has both canvases, and the other way round. In copy mode, links between two copied sets, and between a copied set and a set the target already shows, are copied too; the preview counts the ones that stay behind.

Merging the same thing twice adds nothing: an item whose set the target already shows (link) or already holds a copy of (copy) is skipped and reported.

PDF pages: an image made from a PDF page can carry `page` (`documentSha256`, `pageIndex`, `pageCount`, `pageLabel`, `dpi`, `rotation`, `cropBox`), set by the image intake. If two different renders of the same page end up in one workspace, the preview warns that their marks are not shared.

## Showing and drawing in a workspace

`present_visual { workspaceId }` shows a workspace in the canvas widget: all images side by side at their placement (rotated items are drawn turned), each with its own marks, layers, links and claims. Everything `present_visual` does for one image works per item:

- `annotations`, `findings` and `evidence` take `item` (default: the first item); coordinates are normalized to that item's image. In a paired view the same field is `side`.
- `links` are `{ id, fromItem, from, toItem, to, … }`; `removeLinks` takes link ids; `remove` entries may be `"wi-2:markId"`; `coordinateFrame` takes `item`. If a mark id exists on several items, tools ask for `item` instead of guessing.
- The user draws on whichever image is under the pointer; a mark stays inside the image it was started on. Select, move, restyle, delete, layers (each image has its own, listed by image name), link and claim review, gesture groups and the chat messages to GPT all name the item.
- The widget needs no layout from the model: the server sends each item's placement, and pixels in `_meta` (or the widget fetches each image itself when the host drops them). If two images both have a mark with the same id, the widget shows it as `wi-2:id` and sends the real id.

The app-only tools take `workspaceId` and `item`/`fromItem`/`toItem` in the same way (`validate_visual_annotations`, `edit_visual_canvas`, `review_visual_link`, `review_visual_finding`, `review_gesture_group`, `load_visual_canvas`).

## Preview, commit, retry, undo

`merge_workspaces` and `split_workspace` only **preview** by default. The preview (`estampes.workspace_preview`) lists every image that would be added with its mark, user-mark and layer counts, what is skipped and why, the resulting totals, how many links come along, whether edits will be shared, and warnings. It returns a `previewId`.

`commit: true` with that `previewId` applies exactly the previewed change. If the source or the target changed since, it is refused and has to be previewed again. `edit_workspace` takes `expectedRevision` for the same check.

Every change accepts an `idempotencyKey`. Sending the same key again (for example after a timeout where the change did land) returns the first result with `repeated: true` and applies nothing.

After a commit the server reads the workspace back and compares its totals with the plan: `verified: true` only when they agree and every item's set loads. Otherwise the result lists the mismatch, and GPT is told not to call the merge complete.

Each change returns an `undoToken`. The last 10 are kept per workspace. Undo is refused when a workspace changed again since; undo the later change first. Marks drawn with `present_visual` are not part of a workspace change and are not undone by it.

## Crash safety

A merge, split or move changes two workspaces, and undoing it changes them back. With the UVA store (the default with a storage folder), such a change is saved as one unit:

1. Copied canvases (mode `copy`) are saved first. They are new, so a crash right after them only leaves copies that nothing shows.
2. One **intent** is written durably to `<storage>/uva-pending/intents/<token>.json`. It holds every changed workspace with the change-log line and the sequence number each workspace had before. The change is acknowledged from this point.
3. Each workspace is then written as usual, and the intent is removed once all are.

If the server stops, or a workspace cannot be written, between steps 2 and 3, the intent stays. It is **rolled forward** on the next start and by the periodic retry: a workspace still at its earlier sequence number gets the new value, and one that already has it, or was changed again later, is left alone. Rolling forward twice changes nothing. Until then, reading such a workspace returns the intent's value, so the change never shows in one workspace and not the other. If the intent itself cannot be written, the change fails and neither workspace changes.

The intents folder is part of the storage folder, so a backup of both roots ([Backup](BACKUP-RESTORE.md)) carries an unfinished intent along. `ESTAMPES_CANVAS_STORE=legacy` has no intents: there each workspace file is written on its own.

## Single and paired canvases

`get_workspace_state`, `merge_workspaces` and `split_workspace` accept `img:<hex>` (a single canvas) and `img:<a>+img:<b>` (a paired view) wherever they accept a workspace. These are read as workspaces on the fly (`legacy: { imageId, pairImageId }`, items `wi-1` and `wi-2`) without converting or rewriting anything; left and right become placement only.

## Document

`get_workspace_state` and `GET /api/v1/workspaces/<hex>[?history=N]` return:

```json
{
  "protocol": "estampes.workspace/1",
  "coordinateSystem": "normalized-top-left",
  "id": "ws:0f3c…", "name": "電路與手冊", "revision": 3, "layout": "auto",
  "items": [
    { "id": "wi-1", "asset": "img:2be4…", "set": "img:2be4…", "placement": { "x": 0, "y": 0, "width": 1000, "rotation": 0 } },
    { "id": "wi-2", "asset": "img:7152…", "set": "img:7152…#c4a1b2c3d4e5f", "label": "PCB", "placement": { "x": 1060, "y": 0, "width": 1000, "rotation": 0 } }
  ],
  "assets": [ { "id": "img:2be4…", "width": 1536, "height": 432, "source": "chat-file", "fileName": "opamp.jpg", "page": { "documentSha256": "…", "pageIndex": 4 } } ],
  "sets": [
    { "key": "img:7152…#c4a1b2c3d4e5f", "asset": "img:7152…", "derivedFrom": { "set": "img:7152…", "at": "…" },
      "layers": [ { "id": "L1", "author": "assistant", "name": "來源識別", "order": 0, "count": 1 } ],
      "marks": [ { "id": "user-1r8w-2", "image": "img:7152…", "type": "polyline", "geometry": { … }, "provenance": { "author": "user", "grounding": "user-pointer" },
                   "derivedFrom": { "set": "img:7152…", "mark": "user-1r8w-2" } } ] }
  ],
  "links": [ { "id": "k1", "from": { "item": "wi-1", "mark": "op-0" }, "to": { "item": "wi-2", "mark": "pcb-source" }, "confidence": "low", "verification": { "state": "unverified" } } ],
  "layerBindings": [ { "item": "wi-1", "set": "img:2be4…", "layers": ["L1", "L2"] } ],
  "undo": [ { "token": "u-…", "kind": "link", "at": "…" } ],
  "check": { "ok": true, "items": [ … ], "totals": { "items": 2, "marks": 27, "userMarks": 4, "layerInstances": 7, "links": 1 }, "problems": [] }
}
```

Marks, layers, claims and rejections have the same fields as in [Visual protocol 2](PROTOCOL-V2.md). Fields that do not apply are left out.

## Moving a workspace: `.estampes` bundles

`export_workspace_bundle { workspace }` returns a signed download link for one `.estampes` file (a ZIP). A canvas or paired view is turned into a workspace first. On another server, `import_workspace_bundle { file | bundleUrl }` opens it as a new workspace.

```
manifest.json     format estampes.bundle/1, bundleId, totals, sha256 and size of every other file
workspace.json    items, placement, names (estampes.workspace/1)
assets/<hash>.<ext>   the original image file (or, when the server no longer has it, the working copy as PNG; the manifest says which)
sets/<n>.json     one annotation set: layers, marks, links, rejected claims, gesture decisions, objects
```

- Marks, layers, claims and links are stored as data. Nothing is flattened, re-recognised or renumbered, so every mark stays selectable and editable after import.
- A bundle holds no access key, signed link, chat content or URL. `fileNames:false` leaves original file names out.
- Import checks the format version, every hash and size, rejects unsafe paths and oversized content, and validates each mark (type, 0..1 coordinates, text lengths, enums). A mark that cannot be kept is skipped and reported in `unsupported`; the rest is imported. Hashes detect damage; they do not prove who made the bundle.
- Import never overwrites. An image whose canvas is empty here gets the bundle's canvas; an identical canvas is reused (`collision: "reuse"`); a canvas that already has different marks gets an independent copy (`derivedFrom` remembers it). `collision: "copy"` always copies.
- Importing the same bundle again returns the same workspace (`provenance.bundleId`).
- After import the workspace is read back and compared with the manifest totals (`verified`, `mismatch`, `unsupported`).

### Surface and notebooks in a bundle

When the workspace has a Visual Surface, `export_workspace_bundle` also writes `surface.json` (panels and one layout per device profile) and `notebooks/<n>.json` (calculator definitions, cells and Graph links). On import they are rebuilt from known fields under new ids and nothing is overwritten. Calculator results arrive stale, and their Graph links are marked stale, until you recompute them with SymPy (重算, or 更新所有連結). A bundle without these files imports as before.

## Storage

With `ESTAMPES_STORAGE_DIR`, workspaces are `workspaces/<hex>.json` with a `history.jsonl` beside them, and copied sets are `images/<hash>/sets/<setId>.json` (with their own `marks.svg` and history). Images a stored workspace shows are kept by the retention sweep. Without storage, workspaces and copies live in memory like canvases do.

## Scope

Estampes is self-hosted with one owner per instance, so there are no per-user permissions on workspaces: anyone with the access key can read and change them, and every device connected to the same server sees the same workspaces. Conflicts between devices are caught by revisions (`expectedRevision`, preview checks), not merged automatically.
