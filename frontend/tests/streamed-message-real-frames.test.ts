// Real SSE `message` frames, captured off a live backend, replayed through the
// real `parseStreamedMessage`.
//
// tests/streamed-message.test.ts covers hand-written fixtures — what the parser
// accepts and rejects in principle. This file covers what the *backend actually
// sends*, which is the only thing that can prove the tolerance in
// streamed-message.ts is calibrated correctly rather than merely plausible. A
// frame dropped here is a frozen live transcript in production: the arrival is
// discarded, `lastSeq` never advances past it, and the session appears to stop.
//
// Provenance: captured 2026-09-06 with `curl -N` against the backend running on
// 127.0.0.1:8000 (byte-identical to this branch's merge-base for every file the
// version-skew work touches — i.e. the *pre-unification* publish sites, which is
// precisely the deploy-order case worth pinning: a browser on the new bundle
// talking to a backend that has not yet been restarted). Two streams were read:
// the replay path (`?after=-1`, 1808 frames off a completed session) and the
// live path (`?after=<recent seq>`, 99 frames off a running one). All 1907 were
// accepted. The 11 frames below are the smallest real example of each observed
// (`type`, has-`files`-key) combination.
//
// Only `payload` is edited, and only to keep this file readable: it is
// `z.unknown()` in the schema, so nothing under test reads it. Every top-level
// key — the entire surface `streamedMessageSchema` validates — is verbatim.
//
// Note both shapes below are genuinely on the wire at the same time: 77 of the
// 95 live frames carried NO `files` key (the raw Drizzle row that `sendMessage`
// and the worker's `appendMessage` publish) and 18 carried one (the mapped
// DTO). Requiring `files` would have frozen the transcript on the majority of
// them.

import { expect, test } from 'bun:test'
import { parseStreamedMessage } from '../src/features/sessions/lib/streamed-message'
import { logger } from '../src/shared/lib/logger'
import { afterEach, spyOn } from 'bun:test'

type RealFrame = { type: string; seq: number; files?: unknown[] }

const REAL_FRAMES: RealFrame[] = [
  {
    "id": "b2df2f85-c51b-400e-b956-01f3352a61c3",
    "sessionId": "8e99c67a-8987-43ec-b4a1-2265e60b2a02",
    "seq": 2825,
    "type": "assistant",
    "pending": false,
    "parentToolUseId": "toolu_01QmjoUcD2n9Yf5JS921B1xY",
    "title": "tester: Let me check the background live capture.",
    "payload": {
      "type": "assistant",
      "uuid": "e95c5841-af78-4ea6-b702-2dbfce4e4459",
      "message": {
        "id": "msg_011CenG3EJ5EpzsZ2HPvgFfL",
        "role": "assistant",
        "type": "message",
        "model": "claude-opus-5",
        "usage": {
          "input_tokens": 2,
          "service_tier": "standard",
          "inference_geo": "not_available",
          "output_tokens": 3,
          "cache_creation": {
            "ephemeral_1h_input_tokens": 0,
            "ephemeral_5m_input_tokens": 2204
          },
          "cache_read_input_tokens": 85623
        },
        "content": [
          {
            "text": "Let me check the background live capture.",
            "type": "text"
          }
        ]
      },
      "timestamp": "2026-09-06T13:25:01.955Z",
      "request_id": "req_011CenG3CG3GanamKT1GFpbx",
      "session_id": "200392aa-d987-44be-8bb0-0ec07b1d8142"
    },
    "createdAt": "2026-09-06T13:25:01.967Z"
  },
  {
    "id": "1a938ab9-3abb-40fd-87ea-af24d5cd46f0",
    "sessionId": "aa7d3740-a7e3-4e15-9b30-ba887242e631",
    "seq": 1717,
    "type": "assistant",
    "parentToolUseId": null,
    "title": "orchestrator: All fixes landed.",
    "pending": false,
    "payload": {
      "type": "assistant",
      "uuid": "5cb0cfc2-9845-4eb0-bd6d-49869f447b06",
      "message": {
        "id": "msg_011Cen84eCN3aK7RxeRDNKVH",
        "role": "assistant",
        "type": "message",
        "model": "claude-opus-5",
        "usage": {
          "input_tokens": 2,
          "service_tier": "standard",
          "inference_geo": "not_available",
          "output_tokens": 2,
          "cache_creation": {
            "ephemeral_1h_input_tokens": 7658,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_read_input_tokens": 152506
        },
        "content": [
          {
            "text": "All fixes landed. Final verification pass myself.",
            "type": "text"
          }
        ]
      },
      "timestamp": "2026-09-06T11:40:23.805Z",
      "request_id": "req_011Cen84d9MLAZkcF21NLBkc",
      "session_id": "a37320fc-72b4-407e-9486-3b0b7084c502"
    },
    "files": [],
    "createdAt": "2026-09-06T11:40:23.812Z"
  },
  {
    "id": "16183828-046b-4c0b-a3be-064034c145b3",
    "sessionId": "aa7d3740-a7e3-4e15-9b30-ba887242e631",
    "seq": 1763,
    "type": "prompt",
    "parentToolUseId": null,
    "title": null,
    "pending": false,
    "payload": {
      "text": "commit & push"
    },
    "files": [],
    "createdAt": "2026-09-06T11:47:00.921Z"
  },
  {
    "id": "112af024-a462-484a-aebf-4b9678fe1567",
    "sessionId": "8e99c67a-8987-43ec-b4a1-2265e60b2a02",
    "seq": 2783,
    "type": "rate_limit_event",
    "pending": false,
    "parentToolUseId": null,
    "title": null,
    "payload": {
      "type": "rate_limit_event",
      "uuid": "a4ff04d3-4437-4354-b9c8-5ba04acffe8e",
      "session_id": "200392aa-d987-44be-8bb0-0ec07b1d8142",
      "rate_limit_info": {
        "status": "allowed",
        "resetsAt": 1788718200,
        "overageStatus": "rejected",
        "rateLimitType": "five_hour",
        "isUsingOverage": false,
        "unifiedWindows": {
          "five_hour": {
            "resetsAt": 1788718200,
            "utilization": 0.03
          },
          "seven_day": {
            "resetsAt": 1788739200,
            "utilization": 0.31
          }
        }
      }
    },
    "createdAt": "2026-09-06T13:23:38.449Z"
  },
  {
    "id": "e8da821e-184f-4569-b322-e94d0a2a2e62",
    "sessionId": "aa7d3740-a7e3-4e15-9b30-ba887242e631",
    "seq": 2,
    "type": "rate_limit_event",
    "parentToolUseId": null,
    "title": null,
    "pending": false,
    "payload": {
      "type": "rate_limit_event",
      "uuid": "d0f0dfc2-e8c0-4177-8f9d-a138f3ab3c6f",
      "session_id": "a37320fc-72b4-407e-9486-3b0b7084c502",
      "rate_limit_info": {
        "status": "allowed",
        "resetsAt": 1788700200,
        "overageStatus": "rejected",
        "rateLimitType": "five_hour",
        "isUsingOverage": false,
        "unifiedWindows": {
          "five_hour": {
            "resetsAt": 1788700200,
            "utilization": 0.13
          },
          "seven_day": {
            "resetsAt": 1788739200,
            "utilization": 0.24
          }
        }
      }
    },
    "files": [],
    "createdAt": "2026-09-06T10:35:50.396Z"
  },
  {
    "id": "9f9b3463-61d3-4dc7-8891-987ed02fc1cd",
    "sessionId": "aa7d3740-a7e3-4e15-9b30-ba887242e631",
    "seq": 1807,
    "type": "result",
    "parentToolUseId": null,
    "title": "Turn complete",
    "pending": false,
    "payload": {
      "type": "result",
      "uuid": "2c124bec-0084-47db-888b-a7c4185c237b",
      "usage": {
        "speed": "standard",
        "iterations": [
          {
            "type": "message",
            "input_tokens": 2,
            "output_tokens": 529,
            "cache_creation": {
              "ephemeral_1h_input_tokens": 991,
              "ephemeral_5m_input_tokens": 0
            },
            "cache_read_input_tokens": 173156,
            "cache_creation_input_tokens": 991
          }
        ],
        "input_tokens": 8,
        "service_tier": "standard",
        "inference_geo": "not_available",
        "output_tokens": 3469
      },
      "result": "Pushed, with the full pre-push build intact — no bypass n...",
      "subtype": "success",
      "ttft_ms": 14540
    },
    "files": [],
    "createdAt": "2026-09-06T11:49:09.613Z"
  },
  {
    "id": "33827ba8-ab6f-4a3a-b44b-0808a5f51df1",
    "sessionId": "8e99c67a-8987-43ec-b4a1-2265e60b2a02",
    "seq": 2785,
    "type": "system",
    "pending": false,
    "parentToolUseId": null,
    "title": null,
    "payload": {
      "type": "system",
      "uuid": "8d1baba6-a702-46ac-ba66-e56645f446ad",
      "status": "completed",
      "subtype": "task_notification",
      "summary": "Run production build",
      "task_id": "bcsu4w35p"
    },
    "createdAt": "2026-09-06T13:23:42.475Z"
  },
  {
    "id": "c5d036bc-88c5-4513-976c-7e2fdf75ab88",
    "sessionId": "aa7d3740-a7e3-4e15-9b30-ba887242e631",
    "seq": 696,
    "type": "system",
    "parentToolUseId": null,
    "title": null,
    "pending": false,
    "payload": {
      "type": "system",
      "uuid": "d32a20e8-c87c-411f-924c-c2f62fbed3db",
      "tasks": [],
      "subtype": "background_tasks_changed",
      "session_id": "a37320fc-72b4-407e-9486-3b0b7084c502"
    },
    "files": [],
    "createdAt": "2026-09-06T10:55:16.591Z"
  },
  {
    "id": "1bc04ba3-af74-48d9-ae41-bcee3f2b35e6",
    "sessionId": "aa7d3740-a7e3-4e15-9b30-ba887242e631",
    "seq": 773,
    "type": "tool_progress",
    "parentToolUseId": "toolu_01CxKB5VDw9dyvAnzNEoAJ2d",
    "title": null,
    "pending": false,
    "payload": {
      "type": "tool_progress",
      "uuid": "0103812c-6d4d-4b87-a390-3c3179dcb03a",
      "heartbeat": true,
      "tool_name": "Bash",
      "session_id": "a37320fc-72b4-407e-9486-3b0b7084c502",
      "tool_use_id": "toolu_01CxKB5VDw9dyvAnzNEoAJ2d-heartbeat-0"
    },
    "files": [],
    "createdAt": "2026-09-06T11:01:32.392Z"
  },
  {
    "id": "07cb554a-2113-48e7-adbf-7d6c4709325f",
    "sessionId": "8e99c67a-8987-43ec-b4a1-2265e60b2a02",
    "seq": 2810,
    "type": "user",
    "pending": false,
    "parentToolUseId": "toolu_01QmjoUcD2n9Yf5JS921B1xY",
    "title": null,
    "payload": {
      "type": "user",
      "uuid": "bd784904-b7cd-4ec4-a1ad-af66620ca117",
      "message": {
        "role": "user",
        "content": [
          {
            "type": "tool_result",
            "content": "referenced keys: 349\nMISSING IN EN: []\nMISSING IN RU: []",
            "is_error": false,
            "tool_use_id": "toolu_01Y9kKejC7VS4EXs25VZ6CTo"
          }
        ]
      },
      "timestamp": "2026-09-06T13:24:34.121Z",
      "session_id": "200392aa-d987-44be-8bb0-0ec07b1d8142",
      "subagent_type": "agentoo:tester"
    },
    "createdAt": "2026-09-06T13:24:34.127Z"
  },
  {
    "id": "2aea3168-bd6a-43dd-a592-656efc44417b",
    "sessionId": "aa7d3740-a7e3-4e15-9b30-ba887242e631",
    "seq": 1773,
    "type": "user",
    "parentToolUseId": null,
    "title": null,
    "pending": false,
    "payload": {
      "type": "user",
      "uuid": "e76ab8bb-a08f-4df2-aa13-154621fa59a6",
      "message": {
        "role": "user",
        "content": [
          {
            "type": "tool_result",
            "content": "Launching skill: agentoo:project-conventions",
            "tool_use_id": "toolu_019LumzvEZUq5Yt3EADDuBPF"
          }
        ]
      },
      "timestamp": "2026-09-06T11:47:17.946Z",
      "session_id": "a37320fc-72b4-407e-9486-3b0b7084c502",
      "tool_use_result": {
        "success": true,
        "commandName": "agentoo:project-conventions"
      }
    },
    "files": [],
    "createdAt": "2026-09-06T11:47:17.953Z"
  }
] as RealFrame[]

/** The frame as it comes off the wire: the message wrapped in the event
 *  envelope the backend publishes (`{kind, sessionId, seq, message}`), then
 *  JSON-serialised, exactly as EventSource hands it to the listener. */
const wire = (message: unknown) => JSON.stringify({ kind: 'message', message })

let warn: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  warn?.mockRestore()
  warn = undefined
})

// --- the whole corpus ---------------------------------------------------------

test('every captured combination of message type and files-key is accepted', () => {
  const dropped = REAL_FRAMES.filter((f) => parseStreamedMessage(wire(f)) === undefined)
  expect(dropped.map((f) => `${f.type} files=${'files' in f}`)).toEqual([])
})

test('the corpus really does cover both wire shapes, or it proves nothing', () => {
  // Guards the fixture itself: if a future edit trimmed this down to only
  // DTO-shaped frames, the test above would still pass while no longer
  // exercising the tolerance it exists to pin.
  expect(REAL_FRAMES.some((f) => 'files' in f)).toBe(true)
  expect(REAL_FRAMES.some((f) => !('files' in f))).toBe(true)
})

test('the corpus covers every message type observed on a live backend', () => {
  expect([...new Set(REAL_FRAMES.map((f) => f.type))].sort()).toEqual([
    'assistant',
    'prompt',
    'rate_limit_event',
    'result',
    'system',
    'tool_progress',
    'user',
  ])
})

test('accepting a real frame logs no warning', () => {
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
  for (const f of REAL_FRAMES) parseStreamedMessage(wire(f))
  expect(warn).not.toHaveBeenCalled()
})

// --- per-type, so a failure names the type that broke --------------------------

for (const frame of REAL_FRAMES) {
  const shape = 'files' in frame ? 'DTO (files present)' : 'raw Drizzle row (no files key)'
  test(`a real ${frame.type} frame as a ${shape} survives the boundary`, () => {
    const parsed = parseStreamedMessage(wire(frame))
    expect(parsed).toBeDefined()
    // The two fields the incident turned on: `seq` has to survive as a real
    // finite number or the reconnect cursor goes to NaN, and `type` has to
    // survive or transcript.ts cannot classify the row.
    expect(parsed?.seq).toBe(frame.seq)
    expect(Number.isFinite(parsed?.seq)).toBe(true)
    expect(parsed?.type).toBe(frame.type)
  })
}

// --- the property the reconnect cursor depends on ------------------------------

test('no real frame yields a seq that would poison Math.max with NaN', () => {
  // `append` in use-session-stream.ts does `Math.max(lastSeq, message.seq)`.
  // One non-numeric seq there makes every subsequent `?after=` NaN.
  let cursor = -1
  for (const f of REAL_FRAMES) {
    const parsed = parseStreamedMessage(wire(f))
    if (parsed) cursor = Math.max(cursor, parsed.seq)
  }
  expect(Number.isInteger(cursor)).toBe(true)
})
