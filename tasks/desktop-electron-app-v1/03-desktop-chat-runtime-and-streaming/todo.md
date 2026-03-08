# TODO - Desktop Chat Runtime and Streaming

## Work Items
- [ ] `owner: implementation-agent` - Add a dedicated backend desktop chat module with generate/stream endpoints and desktop-specific request context.
- [ ] `owner: implementation-agent` - Reuse the current orchestration service/engines so desktop can access Zoho, Outreach, and Lark Doc capabilities without duplicating logic.
- [ ] `owner: implementation-agent` - Define a renderer-friendly streaming event contract covering progress, text, completion, and errors.
- [ ] `owner: implementation-agent` - Ensure tool permission and AI role enforcement apply identically for desktop requests.
- [ ] `owner: implementation-agent` - Validate that desktop request logs and runtime metadata clearly identify `desktop` source.

## Deferred
- Background resumable jobs beyond the normal desktop chat loop.
- Rich tool-artifact streaming beyond the required progress/event model.
