# Annotation protocol — early draft

This is a **design sketch**, not a stable public specification.

## Coordinates

Use normalized source-image coordinates in the range `[0, 1]`, with origin at the **top-left of the original image**. Do not anchor geometry to rendered CSS pixels. Maintain the original width and height, and document any crop or rotation transform.

## Example

```json
{
  "schemaVersion": "0.1-draft",
  "image": {
    "id": "image-001",
    "width": 1600,
    "height": 900,
    "revision": "sha256-or-stable-source-revision"
  },
  "annotations": [
    {
      "id": "ann-assistant-001",
      "author": "assistant",
      "type": "rect",
      "geometry": {
        "x": 0.20,
        "y": 0.30,
        "width": 0.14,
        "height": 0.12
      },
      "label": "Example component",
      "certainty": "unverified"
    },
    {
      "id": "ann-user-002",
      "author": "user",
      "type": "point",
      "geometry": {"x": 0.72, "y": 0.45},
      "label": "I mean this one"
    }
  ]
}
```

The example coordinates do not identify a real component.

## Proposed primitive types

- `point`: Single location, useful for direct pointing.
- `rect`: Bounding box around an object.
- `arrow`: Start/end points.
- `path`: Ordered polyline points, useful for tracing routes.
- `text`: Label anchored to a location.

## Validation

- Confirm a known image revision exists before overlaying.
- Reject NaN/out-of-range coordinates and unknown primitive types.
- Preserve annotation author and stable ID.
- Never treat model-supplied certainty as an independent measurement.
- Provide a user-visible way to correct wrongly grounded annotations.

## Open questions

Image permissions, host-compatible resource references, segmentation masks, image transforms, event schemas, annotation history, and cross-client interoperability remain undecided.
