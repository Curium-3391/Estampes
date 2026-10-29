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

1. Verify the latest Render deployment is **Live** and the build tests passed.
2. Open a **new ChatGPT conversation** with Estampes enabled.
3. Say: `使用 Estampes 的 show_number_line 工具，標註數字 2。`
4. Verify the widget heading shows **v0.3.0**, the yellow marker is on **2**, and the widget loads without error.
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
