---
name: hicortex-learn
description: Save an explicit learning or insight to Hicortex long-term memory. Use when you discover something worth remembering across sessions — a lesson, a correction, a pattern, a decision.
version: 0.2.0
user-invocable: true
disable-model-invocation: false
---

# Save Learning to Hicortex

When invoked with `/learn <text>`, store the learning in long-term memory via hicortex_ingest.

## Steps

1. Parse the text after `/learn`
2. Clean it up into a clear, self-contained statement that will make sense months from now
3. Add today's date
4. Call the `hicortex_ingest` tool with:
   - `content`: The learning text
   - `project`: "global" (unless clearly project-specific)
   - `memory_type`: "lesson"

## Example

```
/learn z.ai API uses Bearer auth on all endpoints, not x-api-key
```

Becomes:
```
hicortex_ingest(content="LEARNING: z.ai API uses Bearer auth on all three endpoints (paas, coding, anthropic). Not x-api-key. (2026-03-24)", project="global", memory_type="lesson")
```

## Rules

- Keep it concise — one clear statement
- Include the "why" when relevant
- Include the date for temporal context
- Prefix with "LEARNING:" so it's identifiable in search
- Confirm to the user what was saved (title + confirmation)
