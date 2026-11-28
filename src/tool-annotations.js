// MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) for every tool.
// One table, one reason per row, so each decision can be reviewed; makeServer() applies it and refuses
// to register a tool that has no row (tests/tool-annotations.test.js checks the live tool list too).
//
// How each hint is decided (from what the handler does, never to fill a field):
//   readOnly    false when the call changes anything a user or a module relies on: canvas marks, layers,
//               workspaces, notebooks, modules, panel layout, stored images. Derived-view and render caches
//               that the server can rebuild from the image do not count.
//   destructive true when the call can remove or overwrite data that was there before (delete marks, reset,
//               refresh over an object, remove a workspace, uninstall a module). Additive writes are false.
//               Read-only tools are false.
//   idempotent  true when repeating the call with the same arguments leaves the same state and adds nothing
//               (set-by-id, content-addressed, command-id replay, or a stale second call that is refused).
//               False when a repeat adds another record, another workspace, or toggles. Read-only tools: true.
//   openWorld   true when the call can reach outside this server: fetch a URL, or run module code that may use
//               the network with its approved grant. Everything else: false.

const R = (reason) => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, reason });
const W = (destructive, idempotent, openWorld, reason) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld, reason });

export const TOOL_ANNOTATIONS = {
  // Demo number line
  show_number_line: R("renders a widget, stores nothing"),
  record_number_line_selection: R("validates a number and returns its coordinate"),

  // The shared canvas
  present_visual: { ...W(true, false, true, "saves marks and notes; remove/reset delete marks; imageUrl / pairImageUrl fetch a URL; a marksFile import or history entry is added each call") },
  load_visual_pixels: R("reads pixel slices"),
  upload_visual_image: W(false, false, false, "app-only; each slice is appended to an upload buffer and the last one stores the image"),
  load_visual_canvas: R("app-only; re-sends the canvas payload"),
  documents_get_changes: R("app-only; reads revisions"),
  commands_get_status: R("app-only; reads whether a command id was applied"),
  get_visual_state: R("exports the canvas as JSON"),
  load_visual_region: R("app-only; reads a pixel tile"),
  validate_visual_annotations: W(false, true, false, "app-only; saves the user's marks by id (set, not append); same ids give the same state"),
  review_visual_link: W(false, true, false, "app-only; sets a verdict on one link, repeating sets the same verdict"),
  review_visual_finding: W(false, true, false, "app-only; sets a verdict on one note, repeating sets the same verdict"),
  review_gesture_group: W(false, true, false, "app-only; sets a verdict on a stroke group, repeating sets the same verdict"),
  edit_visual_canvas: W(true, true, false, "app-only; the user's mark and layer edits include delete and reset; a command id makes a retry a no-op"),
  edit_scene_object: W(true, false, false, "app-only; changes, deletes or restores a scene object; restore and relative edits are not repeatable"),
  edit_canvas_text: W(true, false, false, "app-only; creates, updates, deletes or undoes text; create adds one each time"),
  inspect_visual: R("legacy demo SVG crops"),
  present_visual_evidence: R("legacy 3-PNG viewer, renders only"),

  // Images
  load_image: W(false, true, true, "stores a new image (content-addressed id, so the same bytes give the same imageId); imageUrl fetches a URL"),
  add_image_layer: W(false, false, false, "adds new layers on every call"),
  render_canvas: R("renders the canvas without changing it"),
  process_image: R("computes a view; the derived-view record is a rebuildable cache"),
  get_derived_view: R("re-renders a cached view"),
  inspect_image: R("reports metadata"),
  register_images: R("estimates a transform, stores nothing the user relies on"),
  compare_images: R("renders a comparison"),
  assess_image: R("measures sharpness and noise"),
  calibrate_scale: W(false, true, false, "sets the scale of one measurement space; the same input sets the same scale"),
  measure_image: R("computes a measurement, not a mark"),
  render_pdf_page: W(false, true, true, "stores the rendered page as an image (content-addressed); pdfUrl fetches a URL"),
  detect_features: R("returns detections"),
  overlay_grid: R("returns a grid picture and cell centres"),

  // Layers
  get_visual_layers: R("reads layers"),
  edit_visual_layers: W(false, false, false, "changes opacity, visibility, order; undo/redo toggle history, so a repeat can differ"),

  // Workspaces
  create_workspace: W(false, false, true, "makes a new workspace each call (idempotencyKey makes a retry safe); URLs are fetched"),
  edit_workspace: W(false, false, true, "add, detach, arrange; remove only detaches (images and marks are kept, undoable); URLs are fetched"),
  merge_workspaces: W(false, false, false, "links or copies images into another workspace; nothing is deleted; commit makes an undo token"),
  split_workspace: W(false, false, false, "puts images in a new workspace; nothing is deleted; commit makes an undo token"),
  undo_workspace_change: W(true, true, false, "reverts a change, may remove a workspace it created (archived); a second call is refused"),
  export_workspace_bundle: W(false, false, false, "builds a bundle; a canvas or pair first becomes a new workspace"),
  import_workspace_bundle: W(false, true, true, "creates a workspace, importing the same bundle returns the same one; bundleUrl fetches a URL"),
  get_workspace_state: R("exports the workspace as JSON"),

  // Modules and the Store
  open_module_store: R("opens the Store view"),
  list_modules: R("lists modules"),
  search_capabilities: R("searches the catalog"),
  get_module_capabilities: R("reads capability schemas"),
  execute_module: W(true, false, true, "runs a module capability that can overwrite or remove its own objects; a module with an approved network grant can reach hosts it allows"),
  get_module_job: R("reads a job's status"),
  prepare_module_change: R("records a plan for the user to approve; changes no module state"),
  get_derived_bindings: R("lists derived objects"),
  update_derived: W(true, false, false, "refresh, overwrite or detach derived objects; an object the person edited is never overwritten without a preview token"),
  get_flow: R("reads flows"),
  edit_flow: W(false, false, true, "creates, edits, undoes, runs, archives flows; run executes module capabilities that may use the network; commandId makes a retry safe"),
  store_get_catalog: R("app-only; Store catalog"),
  store_get_detail: R("app-only; module details"),
  store_get_plan: R("app-only; records a plan for the user to confirm"),
  store_commit_plan: W(true, true, false, "app-only; applies a confirmed plan (enable, disable, install, update, remove); a plan applied twice reports repeated"),
  store_get_activity: R("app-only; reads recent activity"),

  // Surface and calculator
  surface_get_state: R("app-only; reads panels and notebooks"),
  surface_apply: W(false, true, false, "app-only; opens, closes, moves panels to a set layout"),
  surface_cas: W(false, false, false, "app-only; runs a calculator capability that adds or recomputes notebook cells; runs in a separate sandbox without network"),
  surface_cas_cancel: W(false, true, false, "app-only; cancels one job, repeating changes nothing"),
  get_surface_state: R("reads panels and calculator cells"),
  manage_surface_panels: W(false, true, false, "opens or closes a panel and shows it"),
  uva_store: R("read-only view of the store"),
};

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

export function annotationsFor(name) {
  const row = TOOL_ANNOTATIONS[name];
  if (!row) throw new Error("Tool " + name + " has no row in src/tool-annotations.js: decide its four MCP annotations before registering it");
  return Object.fromEntries(HINTS.map((h) => [h, row[h]]));
}
