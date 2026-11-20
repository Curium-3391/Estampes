# Using Estampes

This guide assumes your server is running and ChatGPT or Claude is connected to it (see the [Quick start](QUICKSTART.md) or [Deployment](DEPLOYMENT.md)). Worked examples with failure paths are in the [tutorials](tutorials/README.md); what has been tried on which client is in [Compatibility](COMPATIBILITY.md). You never need to name a tool: describe what you want in the chat and the AI calls Estampes itself.

## Open a canvas

- **Attach or photograph an image** in a ChatGPT conversation and ask the AI to show it, point something out, or help you mark it ("circle the part that looks damaged", "trace this line", "where is the signature?").
- **Or use the canvas's own button.** Ask the AI to open an upload canvas and press **選擇圖片／拍照** to pick a file or take a photo. This is the way to bring a picture in from Claude, which does not pass chat attachments to tools; it works in ChatGPT too.
- **Or ask the AI to find a picture** by public URL. Estampes fetches only public https addresses (max 20 MB, 50 megapixels).

The canvas opens inside the chat on the **original** image. The AI's marks are gold, yours are blue by default.

## Mark things yourself

Pick a tool, draw on the image, optionally write a short note, and press send. Your marks reach the AI together with their position, so you can say "what is this?" without describing where. The AI may answer by drawing back on the same canvas.

| Tool | What it draws |
| --- | --- |
| 點選 | A point |
| 框選 | An axis-aligned box |
| 箭頭 | An arrow (see below for what it means) |
| 四邊形 | A quadrilateral: drag a box, then in 選取 move each corner on its own (for something seen in perspective) or turn the whole shape with its round handle (for something tilted) |
| 手繪 | A freehand line; mouse, touch, graphics tablet or stylus |
| 文字 | A standalone text label (up to 80 characters) with its own size and colour, which you can drag and edit later |

Below the tools you choose a colour, a line width (極細 is for fine lines when zoomed in) and 筆 or 螢光筆 (translucent, does not hide what is underneath).

- **An arrow means what you say it means.** By default the AI reads it from your note: "the water flows this way" is a direction, "what is this pointing at?" is a pointer. Choose 「只是指出這裡」 under the purpose menu when the arrowhead should always mark the target.
- **Several strokes, one gesture.** If you draw an arrow as a shaft and then a head, Estampes notices that the strokes meet and tells the AI they may be one gesture, as an unconfirmed guess. The candidate appears below the canvas: press 「是同一個手勢」 or 「不是」. To group strokes yourself, select one, press 「和另一筆組成手勢」 and tap the other; 「拆開手勢」 undoes it. Your strokes are never merged or changed.
- Your marks stay on the canvas across turns; the AI will not redraw them, it attaches notes to them instead.

## Select and edit marks

**選取** works on any mark in an unlocked layer, including marks from earlier turns and marks the AI drew:

- **Drag** a mark to move it. Box corners and sides **resize** it; arrow ends, polyline vertices and quadrilateral corners **reshape** it; the round handle **rotates** a box or any closed shape (a turned box becomes a quadrilateral with the same id, label, note and style). Arrow keys nudge, Delete removes.
- **Edit the text** of any mark, the AI's included: its label and a note of several lines. Tapping the drawn label selects its mark too. A changed note drops the old evidence and review of that note. A tap to select never moves the mark; a drag only starts once the pointer travels a few pixels (more for a finger).
- **The AI's marks keep their author and style.** You can move, resize, reshape and relabel them; the mark keeps its author, id, layer and style, and a moved mark is flagged as edited by you. The AI is told exactly what changed, for example that you resized its box and from where to where, or that you rewrote its label from "A" to "甲".
- **上一步 / 下一步** (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y) undo and redo your drawing before you send, and also edits you already sent (move, resize, reshape, restyle, relabel, delete). A step is refused, with the reason, if the mark has changed since or its layer is now locked. The AI hears about it on its next call. Layer edits are not part of this history, which is kept in memory for up to 50 steps per image.
- **清除我的標註** clears what you have drawn but not sent yet.

## Anchors on a Graph

On a Graph canvas (one made by the Graph module, id `gph:`), each mark also says what it belongs to. That decides what happens to it when the axes, the formula or the domain change. Select a mark and use the buttons at the end of the selection bar:

| Button | The mark… | Use it for |
| --- | --- | --- |
| **Pin to page** (固定在畫面, the default) | stays where it is on the canvas | titles, callouts, comments beside the plot |
| **Pin to axes** (固定在座標) | follows the data: it is kept in axis units | a data point, an interval, a box around a cluster |
| **Pin to curve** (固定在曲線, when the Graph has a curve) | follows the curve nearest to it at its x | a root, a maximum, a value of f at some x |

Switching never moves the mark. The AI picks an anchor for each mark it draws, and you can change it; the AI is told when you do. Two notices can appear under the canvas:

- **Outside the axes range** (超出座標範圍): the mark's place is out of view. It is kept, not drawn, and comes back when the range includes it again.
- **Anchor lost** (錨點失效): its axes or curve was deleted, or the curve is no longer defined at its x. The mark stays where it was and is still drawn. Select it and pin it to a curve again, or pin it to the page.

A mark pinned to the axes cannot be dragged out of their range, and one pinned to a curve cannot be dragged to where the curve is not drawn; pin it to the page first. If the curve under a note you confirmed is re-defined, the note asks you to confirm it again. Images have no anchors: their marks always stay on the picture. Details for the AI and developers: [Modules](MODULES.md#marks-fixed-to-the-axes-graph-documents).

## Zoom and pan

Pinch, Ctrl+wheel or the ＋／－ buttons zoom, and 整張 shows the whole image again. Drag with 移動 (or hold Space, or drag with the middle mouse button) to move the image. Three kinds of pixels can be on screen while you zoom:

- **Working copy.** The picture shown at first, reduced so its long side is at most 4096 px by default (`ESTAMPES_WORKING_LONG_SIDE`). Marks and coordinates always refer to this image's proportions.
- **Detail tile.** When you zoom in, the canvas asks the server for a sharper tile of the area you are looking at. If your original file is larger than the working copy and the area is small enough, the tile is cut from the **original file** (real pixels, nothing guessed). Otherwise it is cut from the working copy. The server never enlarges a tile. The readout under the canvas says 「原始解析度」 whenever a detail tile is shown; it does not by itself prove the pixels came from the original file.
- **Interpolated zoom.** Zooming further than a tile's pixels can fill makes the browser scale the pixels up. That adds no information; do not read fine detail from it.

When the AI needs real detail it asks for a `native` view itself ([Image pipeline](IMAGE-PIPELINE.md)); processed views report whether they are interpolated.

## Layers

Every time you send marks, and every time the AI draws, the marks form a **layer**. The layer panel under the image lets you:

- show or hide a layer (checkbox),
- rename, reorder, fade (opacity) and lock it,
- copy its id (`L6`) by clicking it, to refer to it in the chat.

Visibility, order and opacity are shared: the AI sees them and can change them too, with the same undo. Neither side can change or delete marks in a locked layer, so lock what you consider final. The AI may still attach a note to a locked mark.

## While the canvas is open

- **Changes arrive by themselves.** An open canvas checks the server about every two seconds while it is visible (and at once when you return to it), so marks, layers and links the AI or another conversation changed appear without reopening it. Your unsent marks, zoom, tool and selection are never touched, and an update waits while you are drawing, dragging or typing. Paired views are not updated this way yet.
- **Background work does not reopen the canvas.** When the AI runs a module repeatedly or checks on a job that is still running, the chat shows a one-line note 「AI 正在背景更新或檢查畫布」 with a 顯示畫布 button instead of a new canvas. A finished job or an explicit request to show the canvas opens it as usual.

## Compare two images

Ask the AI to compare two different pictures (a drawing and the real object, a map and an aerial photo, before and after). They appear **side by side**, never overlaid. The AI records links between a mark on the left and the matching mark on the right. For more than two images, or to overlay an aligned pair, ask for a workspace ([Workspaces](WORKSPACES.md)).

## Check the AI's claims

A note the AI writes on a mark ("this is the signature", "this is R12") and a link between two images are **claims**. Each one shows the AI's confidence, the evidence it gives, and what is still unresolved. Every piece of evidence is a button: press it to zoom to the spot the AI says it read, outlined in red, and judge for yourself.

A claim stays 「待你確認」 until you press 確認 or 否決, however confident the AI is; 「僅模型自述」 means only the AI's own reading supports it. Add a reason when you reject, and 撤回 takes your verdict back. Press send so the AI hears about it at once; it also sees it on its next call. If you move a mark at either end of a link you confirmed, the link asks for your confirmation again.

A rejection is remembered for that place on the image, even if the marks are deleted or redrawn. If the AI says the same thing there again without a new kind of evidence, Estampes refuses it and tells the AI why.

## What the AI does to see better

On request, or when a detail is too small, the AI can ask Estampes for a processed view of a region: contrast enhancement (CLAHE), sharpen, denoise, black-and-white thresholding, edge detection, zoom up to 8x, or a labelled grid ("it is in C7"). You normally see the original; processed versions appear as extra tabs only when the AI thinks they help you.

Estampes only transforms pixels and keeps coordinates honest. **What is in the picture is the AI's judgement**, so check important answers yourself. After drawing, the AI receives a verification crop with and without its marks and is expected to check they sit on the right pixels.

## Save and reuse your work

- **Export:** the result includes download links for the image (`image.jpg`) and a layered `marks.svg` (one Inkscape layer per Estampes layer). When an access key is set, the links are signed.
- **Restore:** attach an exported marks SVG (or an `estampes.visual/2` JSON, see [Visual protocol 2](PROTOCOL-V2.md)) to a new chat and ask the AI to load it onto the image. A whole workspace travels as one `.estampes` file.
- **Server storage:** with `ESTAMPES_STORAGE_DIR` set (Docker does this), marks, layers and history are kept in the [UVA store](UVA-BETA.md) and survive restarts, and attaching the same image again in a new chat brings its canvas back. Without it, canvases live in memory for about an hour.

## Troubleshooting

For server, connector, widget, calculator and module problems see [Troubleshooting](TROUBLESHOOTING.md). Quick answers:

| Symptom | What to try |
| --- | --- |
| The host does not offer the tools after you changed the server | Refresh the connector, then start a **new conversation**. |
| The canvas shows a squashed or empty image | Resize the chat or reopen the canvas by asking the AI to show it again. |
| Photo fails to load after zooming | Ask the AI to show the canvas again; the server reloads the image from `imageId`. |
| Marks vanished after a long break | Without storage the server forgets images after the cache time (default 60 min). Re-attach the image or the exported marks file. |
| An undo step is refused | The mark changed after that step or its layer was locked; the message says which. |
