// Tool-use guidance for the model (issue #87).
//
// Observed in a live ChatGPT session: after an image was uploaded through the
// canvas, the assistant told the user that the Estampes drawing tools were
// unavailable, without having called any of them; later it said it could not
// check an async job, without calling get_module_job. Both tools worked when
// they were finally called. The root cause is on the model side, but the
// server can make the right path explicit and make real failures unmistakable:
//
// 1. Server instructions (sent once in `initialize`) say what is available,
//    which tool to call next for the common follow-ups, and how to report the
//    difference between "not attempted", "failed (with the returned error)",
//    "running" and "done".
// 2. Every error result names the tool that replied, so the model can quote a
//    real Estampes error instead of guessing about permissions or bindings.
// 3. The canvas upload message (public/visual-surface.html) names the tools
//    and imageId to use next, and says no re-upload is needed.

export const SERVER_INSTRUCTIONS = [
  "Estampes is a shared visual canvas: you and the user annotate the same image (any kind of image).",
  "If these tools are listed, they are connected. Never tell the user a tool is unavailable, unauthorised or not bound unless a call you made returned an error saying so; quote that error.",
  "Typical follow-ups:",
  "- The user uploaded or picked an image on the canvas (the conversation names its imageId): look with inspect_image({imageId}), then draw with present_visual({imageId, annotations}) on that same canvas. Do not ask for a re-upload.",
  "- A module job is running (execute_module returned a job id): call get_module_job({job, waitSeconds}) before answering whether it is done.",
  "- To check your own drawing without reopening the user's canvas, call render_canvas (it does not change what the user sees).",
  "When reporting a step, say which one applies: not attempted, called and failed (give the returned error), running, done.",
  "If a capability is genuinely missing (for example no plate-solving module is installed or enabled), say exactly that, and offer clearly labelled visual estimates instead; this does not make the canvas tools unavailable.",
].join("\n");

// A second text block on every error result, naming the tool that replied.
// It is appended, not prepended: widgets show content[0].text to the user,
// and that stays exactly the tool's own message.
export const provenanceNote = (tool) => "(Estampes " + tool + " returned this error; the tool is connected and ran. Report this error as it is; do not describe it as missing access.)";

export function withErrorProvenance(tool, result) {
  if (!result?.isError || !Array.isArray(result.content)) return result;
  const note = provenanceNote(tool);
  if (result.content.some((c) => c?.type === "text" && c.text === note)) return result;
  return { ...result, content: [...result.content, { type: "text", text: note }] };
}
