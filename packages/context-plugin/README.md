# opencode-context-compression

Thin OpenCode adapter for `@ssshake/context-core`.

Current hook coverage:

- `tool.execute.after`
  - Compresses large tool outputs before they are persisted in the session.
- `experimental.chat.messages.transform`
  - Applies conservative topic-aware truncation to older assistant text and tool outputs before messages are sent to the model.
- `experimental.session.compacting`
  - Replaces the default continuation summary prompt with a structure aligned to the extracted context-core model.

This package intentionally avoids deep OpenCode core changes. It is designed to validate the integration path first, then move selected pieces into the host once the hook-based behavior is proven stable.

Example config:

```json
{
  "plugin": [
    [
      "opencode-context-compression",
      {
        "toolResultMaxTokens": 1200,
        "minMessages": 10,
        "replaceCompactionPrompt": true
      }
    ]
  ]
}
```
