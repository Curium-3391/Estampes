# Using Estampes in ChatGPT

This guide assumes your server is running and ChatGPT is connected to it (see [Deployment](DEPLOYMENT.md)). You never need to name a tool: describe what you want in the chat and GPT calls Estampes itself.

## Open a canvas

- **Attach or photograph an image** in the chat and ask GPT to show it, point something out, or help you mark it ("circle the part that looks damaged", "trace this line", "where is the signature?").
- **Or ask GPT to find a picture** by public URL. Estampes fetches only public https addresses (max 20 MB, 50 megapixels).

The canvas opens inside the chat on the **original** image. GPT's marks are gold, yours are blue.

## Mark things yourself

Pick a pen, highlighter, box or arrow, draw on the image, optionally write a short note, and press send. Your marks reach GPT together with their position, so you can say "what is this?" without describing where. GPT may answer by drawing back on the same canvas.

- **Undo / redo** works on your own drawing before you send.
- **Select** lets you move, restyle or delete a single mark, including marks from earlier turns.
- Your marks stay on the canvas across turns; GPT will not redraw them, it attaches notes to them instead.

## Zoom and pan

Pinch, Ctrl+wheel or the zoom buttons zoom in; the pan tool moves the image. While you zoom, Estampes loads the image at its working resolution (the long side is 4096 px by default), so small details become readable. The readout under the canvas shows the resolution you are looking at.

## Layers

Every time you send marks, and every time GPT draws, the marks form a **layer**. The layer panel under the image lets you:

- show or hide a layer (checkbox),
- rename, reorder, fade (opacity) and lock it.

GPT does not change or delete marks in a locked layer, so lock what you consider final.

## Compare two images

Ask GPT to compare two different pictures (a drawing and the real object, a map and an aerial photo, before and after). They appear **side by side**, never overlaid. GPT records links between a mark on the left and the matching mark on the right.

## Check GPT's claims

A note GPT writes on a mark ("this is R12") and a link between two images are **claims**. Each one shows GPT's confidence, the evidence it gives, and what is still unresolved. Every piece of evidence is a button: press it to zoom to the spot GPT says it read, outlined in red, and judge for yourself.

A claim stays 「待你確認」 until you press 確認 or 否決, however confident GPT is; 「僅模型自述」 means only GPT's own reading supports it. Add a reason when you reject, and 撤回 takes your verdict back. Press send so GPT hears about it at once; it also sees it on its next call.

A rejection is remembered for that place on the image, even if the marks are deleted or redrawn. If GPT says the same thing there again without a new kind of evidence, Estampes refuses it and tells GPT why.

## What GPT does to see better

On request, or when a detail is too small, GPT can ask Estampes for a processed view of a region: contrast enhancement (CLAHE), sharpen, denoise, black-and-white thresholding, edge detection, zoom up to 8x, or a labelled grid ("it is in C7"). You normally see the original; processed versions appear as extra tabs only when GPT thinks they help you.

Estampes only transforms pixels and keeps coordinates honest. **What is in the picture is GPT's judgement**, so check important answers yourself. After drawing, GPT receives a verification crop with and without its marks and is expected to check they sit on the right pixels.

## Save and reuse your work

- **Export:** the result includes download links for the image (`image.jpg`) and a layered `marks.svg` (one Inkscape layer per Estampes layer). When an access key is set, the links are signed.
- **Restore:** attach an exported marks SVG (or an `estampes.visual/2` JSON, see [Visual protocol 2](PROTOCOL-V2.md)) to a new chat and ask GPT to load it onto the image.
- **Server storage:** with `ESTAMPES_STORAGE_DIR` set (Docker does this), marks, layers and history survive restarts, and attaching the same image again in a new chat brings its canvas back. Without it, canvases live in memory for about an hour.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| ChatGPT does not offer the tools after you changed the server | Refresh the connector, then start a **new conversation**. |
| The canvas shows a squashed or empty image | Resize the chat or reopen the canvas by asking GPT to show it again. |
| Photo fails to load after zooming | Ask GPT to show the canvas again; the server reloads the image from `imageId`. |
| Marks vanished after a long break | Without storage the server forgets images after the cache time (default 60 min). Re-attach the image or the exported marks file. |
