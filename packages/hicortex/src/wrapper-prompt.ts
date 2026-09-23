/**
 * The shared wrapper-prompt classifier (#489).
 *
 * ONE function imported by BOTH recall layers — the CC hook client
 * (recall-hook-cli.ts buildHookRequest) and the server handler
 * (recall-index.ts handleRecallIndex) — so the two can never drift on what
 * counts as harness plumbing.
 *
 * What CC delivers as user-role wrapper messages (wild-verified over 250
 * sampled session files + the latest live recall_pushes rows, #489
 * refinement): `<task-notification>`, `<agent-message>`, local-command-caveat`,
 * `<command-name>`/`<command-message>`/`<command-args>` (slash-command
 * envelope), `<local-command-stdout>`, `<system-reminder>`, and
 * `[Request interrupted…]` markers. These reach /recall-index verbatim today —
 * ~15% of live pushes — inflating shown_count, burning hook latency, and
 * polluting the Memory Precision denominator.
 *
 * The rule (owner decision 4, refinement A1 — skip ONLY pure plumbing):
 * strip every known wrapper element, then measure PAYLOAD PROSE = the text
 * left outside wrappers PLUS the bodies of `<result>` elements and
 * `<agent-message>` elements (the payload channels — a subagent hand-back is
 * real prose even though it arrives wrapped; the gold-set exception recalled
 * usefully). Pure wrapper ⟺ payload prose is shorter than
 * RECALL_MIN_PROMPT_CHARS — the SAME bar as the short-prompt gate: one
 * constant, one meaning, "enough words to recall on". `<summary>` ("Agent X
 * finished") and `<note>` are plumbing, never prose — otherwise every
 * notification would pass and the skip would never fire.
 *
 * Conservative by construction:
 *   - NO wrapper marker at all → not a pure wrapper, whatever the length (a
 *     short plain prompt is the short-prompt gate's business, not this one).
 *   - A malformed or truncated wrapper does not match its strip regex, so its
 *     text counts as payload prose → not a pure wrapper → recalls.
 *   - An empty string is NOT classified here — the caller's empty check owns
 *     that case.
 */

import { RECALL_MIN_PROMPT_CHARS } from "./calibration.js";

/**
 * Opening-tag detector — the precondition: only a prompt that actually
 * CARRIES a known wrapper marker can be a pure wrapper. Bare and unclosed
 * tags both match this; the strip pass below then decides how much survives
 * as prose.
 */
const WRAPPER_MARKER =
  /<(?:task-notification|agent-message|local-command-caveat|command-name|command-message|command-args|local-command-stdout|system-reminder|result)\b/;

/** Interrupt-marker presence — carries the same precondition weight as a
 *  wrapper tag (a marker-only prompt has no tags to detect). */
const INTERRUPT_MARKER_ANY = /\[Request interrupted by user[^\]]*\]/;

/**
 * Wrapper element signatures. Non-greedy, bounded (the cleanMessageContent
 * regex posture — no unbounded backtracking on pathological input; bodies
 * beyond the cap fail to match and count as prose, the conservative
 * direction). `[\s\S]` so multi-line bodies strip correctly.
 *
 * Payload channels (`task-notification`'s `<result>`, `agent-message` bodies)
 * are handled separately below — their content is EXTRACTED as prose, not
 * stripped as plumbing.
 */
const WRAPPER_ELEMENTS: RegExp[] = [
  // task-notification: envelope stripped; an inner <result> body is harvested
  // as prose by PAYLOAD_ELEMENT_BODIES (runs BEFORE this strip).
  /<task-notification[^>]*>[\s\S]{0,50000}?<\/task-notification>/g,
  /<local-command-caveat>[\s\S]{0,10000}?<\/local-command-caveat>/g,
  /<command-name>[\s\S]{0,1000}?<\/command-name>/g,
  /<command-message>[\s\S]{0,5000}?<\/command-message>/g,
  /<command-args>[\s\S]{0,10000}?<\/command-args>/g,
  /<local-command-stdout[^>]*>[\s\S]{0,100000}?<\/local-command-stdout>/g,
  /<system-reminder[^>]*>[\s\S]{0,10000}?<\/system-reminder>/g,
  // Payload-channel ENVELOPES strip here too — AFTER their bodies were
  // harvested below (harvest runs first). The tags themselves are plumbing:
  // an empty <agent-message></agent-message> must leave nothing behind, and
  // a lone <result>…</result> must measure only its body.
  /<agent-message[^>]*>[\s\S]{0,100000}?<\/agent-message>/g,
  /<result[^>]*>[\s\S]{0,100000}?<\/result>/g,
];

/**
 * Payload channels — bodies that COUNT AS PROSE even though they sit inside a
 * wrapper: the `<result>` of a task-notification (a report) and the full body
 * of an `<agent-message>` (inter-agent prose, e.g. a subagent hand-back).
 * `<agent-message>` is NOT in WRAPPER_ELEMENTS for exactly this reason: its
 * whole body is payload, so it is harvested here and never stripped.
 */
const PAYLOAD_ELEMENT_BODIES: RegExp[] = [
  /<result[^>]*>([\s\S]{0,100000}?)<\/result>/g,
  /<agent-message[^>]*>([\s\S]{0,100000}?)<\/agent-message>/g,
];

/** Interrupt markers — whole-line plumbing (either flavor). */
const INTERRUPT_MARKER = /^\s*\[Request interrupted by user[^\]]*\]\s*$/gm;

/**
 * True when the prompt is PURE plumbing: after removing known wrapper
 * elements, the payload prose (leftover text + result/agent-message bodies)
 * is shorter than RECALL_MIN_PROMPT_CHARS. False for anything prose-bearing,
 * malformed, wrapper-free, or empty — those recall exactly as today.
 */
export function isPureWrapperPrompt(prompt: string): boolean {
  if (!prompt) return false;
  if (!WRAPPER_MARKER.test(prompt) && !INTERRUPT_MARKER_ANY.test(prompt)) return false;

  let payload = "";
  // Harvest payload-channel bodies FIRST (agent-message is never stripped;
  // task-notification's <result> is harvested before its envelope strips).
  for (const re of PAYLOAD_ELEMENT_BODIES) {
    for (const m of prompt.matchAll(re)) {
      payload += " " + (m[1] ?? "");
    }
  }

  // Strip the remaining wrapper envelopes + interrupt markers; what is left
  // over is outside-wrapper prose.
  let rest = prompt;
  for (const re of WRAPPER_ELEMENTS) {
    rest = rest.replace(re, " ");
  }
  rest = rest.replace(INTERRUPT_MARKER, " ");
  payload += " " + rest;

  // Whitespace-collapsed length is the prose bar — indentation and newlines
  // are not words.
  const prose = payload.replace(/\s+/g, " ").trim();
  return prose.length < RECALL_MIN_PROMPT_CHARS;
}
