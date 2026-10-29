# M0 — ChatGPT inline number-line smoke test

## Requirements

Node.js 20+ and a public HTTPS endpoint for ChatGPT to contact the MCP server. You do not need a separate end-user drawing website; the widget is served as an MCP Apps resource **inside ChatGPT**.

## Run

```sh
npm install
npm test
npm start
```

The server listens at `http://localhost:8787/mcp`. Use a tunnel or deployment to give ChatGPT an HTTPS address. For example: `ngrok http 8787` (run on the same machine as the server).

## Connect to ChatGPT

In ChatGPT, go to Plugins → Add custom MCP server, provide your public `https://<host>/mcp` URL, and install the private plugin. Open a conversation, choose `@Estampes`, and say:

> Show the Estampes number line and point to 2.

The widget should show the assistant's golden mark at 2. Tap -1, then press **傳給 GPT**. Check that a user-role message containing `value:-1` and `x:0.375` appears in the conversation, and that ChatGPT responds. The bridge includes a visible error if message sending fails; some host versions may require an explicit composer send.

## Acceptance criteria

- Tool discovery and `show_number_line` invocation
- Inline widget rendering, not an external page
- Assistant's target matches the tick
- User selection matches the tick and normalizes to original number-line coordinates
- Screen resizing leaves markers on their ticks
- User selection reaches the chat context (not just local widget state)

## Limitations

This is a **source scaffold** and has not yet been verified end-to-end in a connected ChatGPT client. The current tool controls its own number-line image; it cannot annotate an arbitrary image already shown by native ChatGPT search. No production deployment, persistence, or authentication is included.
