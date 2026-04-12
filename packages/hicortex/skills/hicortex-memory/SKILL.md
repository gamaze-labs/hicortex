---
name: hicortex-memory
description: Long-term memory tools for searching past knowledge, decisions, and lessons. Use when the user references past work, asks about previous decisions, or when you need context from earlier sessions.
version: 0.2.0
disable-model-invocation: false
---

# Hicortex Long-term Memory

You have access to a long-term memory system that stores knowledge from past sessions. Use it proactively.

## When to use hicortex_search

- User asks "what did we decide about X?" or "have we dealt with this before?"
- You need context about a project, decision, or past conversation
- You're about to make a decision that might contradict past work
- Starting work on a project you've worked on before

## When to use hicortex_context

- At the start of a session to recall recent project state
- When switching between projects to load relevant context

## When to use hicortex_ingest

- User explicitly asks you to remember something
- An important decision is made that should persist
- A lesson is learned that should apply to future sessions

## When to use hicortex_lessons

- Before starting a task, check if there are relevant lessons
- When debugging an issue that may have been solved before

## Important

- Lessons are auto-injected at session start — you don't need to fetch them manually
- Sessions are auto-captured — you don't need to manually save conversations
- Memory search uses semantic similarity — use natural language queries, not keywords
