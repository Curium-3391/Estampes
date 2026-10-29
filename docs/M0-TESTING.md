# Estampes M0.3 — ChatGPT native round-trip test

## Scope

This milestone uses an in-chat MCP Apps UI—not a separate whiteboard or website.

- Model → UI: `show_number_line({target: 2})` renders a number line from -4 to 4.
- User → Server: Clicking -2 and pressing **傳給 GPT** calls the app-only `record_number_line_selection({value:-2})` tool.
- User → Chat: The widget independently sends a `ui/message` request containing the user's selection, with normalized `x=0.25`.

The server's record tool is **stateless**; it validates and echoes the coordinate. A successful tool call by itself **does not** mean the model has received a new chat message.

## Development

```sh
npm install
npm test
npm start
```

The HTTP endpoint is `http://localhost:8787/mcp`. The cloud endpoint configured in ChatGPT is `https://estampes-mcp.onrender.com/mcp`.

## In-Chat test

1. First open the public **[deployed version endpoint](https://estampes-mcp.onrender.com/version)**. It must return `version: m0.3.1`, `uiResourceUri: ui://estampes/number-line-v031.html`, and `selectionTool: record_number_line_selection`. If not, the deployment has not caught up; don't debug ChatGPT yet. Then verify Render's latest deployment is **Live** and build tests passed.
2. Open a **new ChatGPT conversation** with Estampes enabled.
3. Say: `使用 Estampes 的 show_number_line 工具，標註數字 2。`
4. Verify the widget heading shows **v0.3.1**, the yellow marker is on **2**, and the widget loads without error.
5. Click **-2**. The blue marker should move to -2.
6. Click **傳給 GPT**.
7. Observe **both** the status line and the conversation. A successful two-way round trip requires ChatGPT to acknowledge **-2** from the new user message.

## Diagnostics

| Status line | Meaning |
|---|---|
| `座標已驗證；訊息已交給聊天宿主…` | App→MCP echo succeeded; host accepted the chat request. Confirm that the model actually responds. |
| `工具驗證失敗…訊息已交給聊天宿主…` | App→MCP tool failed but chat bridge may still work. |
| `座標驗證成功；聊天橋接失敗…` | The tool is working, but `ui/message` failed. |
| Both paths failed | The widget shows the value/x so it can be typed into the chat manually. |

If `Unknown tool` appears, verify the currently deployed server includes `record_number_line_selection` and that ChatGPT fetched the updated tool metadata. Do not assume a successful Render deploy forces ChatGPT to refresh its cached UI.

## Automated checks

- `tests/geometry.test.js`: numeric coordinate conversion.
- `tests/mcp-http.test.js`: discovery, both tool calls, UI resource.
- `tests/widget-contract.test.js`: widget script syntax and independent tool/chat paths.

## Limits

- No image search integration, persistence, authentication, or multi-user state.
- No guarantee that every ChatGPT host accepts `ui/message`; confirm by observing the actual conversation.
- The tool's current coordinate `x` refers to the logical number line interval, not a screenshot pixel position.
- The Render endpoint is unauthenticated: only use non-sensitive M0 test data.

## UI caching and refresh

Per the [official ChatGPT UI documentation](https://developers.openai.com/plugins/build/chatgpt-ui), MCP Apps `ui://` URI is a cache key. Versioning the URI is mandatory for template changes. M0.3.1 uses `ui://estampes/number-line-v031.html` and retains `ui://estampes/number-line.html` as a legacy alias.

If `/version` reports `m0.3.1` but ChatGPT still displays `v0.1.2`, the host is using stale resource/tool metadata. Refresh the custom MCP server's actions in plugin settings where supported, then start a new conversation. Only if there is no refresh action, consider reinstalling the custom plugin to force rediscovery.

`Unknown tool` with the **old** UI does not prove the new server lacks the tool. It may be an old iframe calling the current MCP server. Likewise, HTTP 200 only proves an HTTP response; the user-to-chat round trip requires the model's actual acknowledgement.

## M0.3.2 — Private tool scan compatibility

ChatGPT's plugin scan rejected `record_number_line_selection` with a message that private tools cannot render widgets. The app-only selection tool now has only `_meta.ui.visibility: ["app"]` with **no** UI resource URI. The public `show_number_line` tool alone advertises `ui://estampes/number-line-v031.html`.

To verify the server deploy, visit `https://estampes-mcp.onrender.com/version` and confirm `version: m0.3.2`. Then rerun ChatGPT's MCP tool scan/Refresh. This is a targeted compatibility hypothesis: successful scanning does not yet demonstrate that the app-only tool is callable by the UI.

If scan succeeds, start a new conversation and test the number-line button. If scan still fails, capture the exact scan error rather than changing further unrelated code.
