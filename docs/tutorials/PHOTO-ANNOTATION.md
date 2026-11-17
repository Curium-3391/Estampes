# Tutorial: annotate a photo

Goal: put an image on the shared canvas, let GPT mark something, mark something yourself, and check GPT's claim. The example is a circuit board; the steps are the same for a map, a drawing or a plant.

Needs: a running server connected to ChatGPT ([Quick start](../QUICKSTART.md)). Material: `sample-material/sample-board.png` ([how to make it](README.md#test-material)) or any image. No optional features.

## Success path

**1. Show the image.** Attach the picture and write: *"Show this image and mark where R12 is."*

- Expected: a canvas opens in the chat on the original image; GPT draws a gold mark. **Model inference:** which part is R12. **Tool result:** the mark's position and a verification crop (GPT receives the area with and without its marks).
- Check: is the gold mark on the part labelled R12? If GPT's mark is elsewhere, that is a wrong inference; say so ("no, R12 is the small brown part top centre") and ask it to correct.

**2. Mark something yourself.** Pick the pen, circle the part labelled D7, type "what is wrong with this?" and press send.

- Expected: your mark is blue, GPT receives its position with your note, and answers about that spot. **User action:** your mark records only geometry and your note; it is not a claim.

**3. Draw an arrow.** Draw an arrow from U1 toward R12 and write "current flows this way". 

- Expected: GPT treats it as a direction because of your note. Without a note, or if you choose 「只是指出這裡」 in the purpose menu, the arrowhead means "this is the target". See [What your marks mean](../TOOLS.md#what-your-marks-mean).

**4. Check a claim.** Ask: *"Label the parts you can read and say how sure you are."*

- Expected: each label is a **claim** with confidence and evidence. It stays 「待你確認」 until you press 確認 or 否決 on it. **User confirmation:** only your verdict changes its state. Press an evidence button to zoom to the spot GPT says it read, outlined in red.
- Reject one with a reason. If GPT repeats the same claim at that place without new evidence, Estampes refuses it ([Usage](../USAGE.md#check-the-ais-claims)).

**5. Zoom.** Zoom into U2.

- Expected: a sharper tile loads. If your file is larger than the working copy (long side 4096 by default) and the area is small, the tile is cut from the original file; otherwise it comes from the working copy and is never enlarged. For `sample-board.png` (1200 px) both are the same, so zooming past the file's pixels only enlarges them. The readout 「原始解析度」 does not by itself prove source pixels ([Zoom and pan](../USAGE.md#zoom-and-pan)).

**6. Keep it.** Ask for the export. Expected: download links for the image and a layered `marks.svg`. With the Docker defaults the canvas also survives a restart; attach the same image in a new chat and ask GPT to show it.

## Failure and degraded paths

| What happens | Why | What to do |
| --- | --- | --- |
| GPT replies in text and no canvas appears | Connector not active in this conversation | New conversation, enable the connector. |
| The mark is on the wrong part | **Model inference** error (this is normal) | Tell GPT where it is, or draw it yourself. Do not treat any unconfirmed claim as fact. |
| GPT says it cannot read small text | The part is a few pixels wide | Ask it to look at a processed view or native-resolution crop (`process_image`, contrast/sharpen, `sampling: native`); on `sample-board.png` there is no more detail than the file holds. |
| Marks gone after a break | No storage configured and the cache expired (about 60 min) | Re-attach the image or the exported marks; turn storage on. |
| Image fails to load after zooming | Host dropped the pixels | Ask GPT to show the canvas again. |

## What this tutorial does not show

Layers and locking, paired images and workspaces: see [Usage](../USAGE.md) and [Workspaces](../WORKSPACES.md).
