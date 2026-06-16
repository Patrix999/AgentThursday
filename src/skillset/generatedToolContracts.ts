// GENERATED — DO NOT EDIT BY HAND.
// Source: docs/tools/*.yaml
// Regenerate via: npm run tools:generate
// CI guard:        npm run tools:check
//
//   — yaml → tool contract codegen.
// Output is unioned over the hand-written CONTRACTS array in
// contractRegistry.ts at module load; duplicate tool_ids throw.

/* eslint-disable */
// prettier-ignore

import type { ToolContract } from "./contractRegistry";

export const GENERATED_TOOL_CONTRACTS: ToolContract[] = [
  ({
    "tool_id": "admin.smoke",
    "description": "跑一个 allowlisted harmless admin smoke case，对真实 admin endpoint 做端到端验证； 不直接接触 AGENT_THURSDAY_SHARED_SECRET（由 adapter 边界注入），返回结构化 evidence。 case_id=sandbox-exec-printf 走 sandbox HTTP path； case_id=remember-ack-empty-fallback 走 in-process helper； 新增四个 cliStubProbe case_id（context-active-inspect-smoke / context-lifecycle-noop-smoke / compaction-plan-dry-run-smoke / archive-inspect-smoke）走 AgentThursdayAgent stub @callable，验证  Step 6（Cards 281–286）context/archive/compaction free function 抽取的行为保留； 新增 case_id=cli-status-dashboard-shape-smoke，走 adapter-side requireSecret 注入 + getDashboardCore 调用 + buildDashboardSectionFree 组合，返回 dashboard 六个 top-level key 的 presence booleans + outbox/patch-apply 的 kind 判别 + drift flag 名称白名单 + version 字段 presence。所有 case 都是 read-only 或 documented no-op；不会修改消息、archive、active pointer，不会触发 destructive lifecycle 操作。缺 env binding（Sandbox / AgentThursdayAgent / Secret）或 stub 方法抛错时回 `blocked`，不抛 503/500。",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/admin/smoke"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "case_id": {
          "type": "string",
          "enum": [
            "sandbox-exec-printf",
            "remember-ack-empty-fallback",
            "context-active-inspect-smoke",
            "context-lifecycle-noop-smoke",
            "compaction-plan-dry-run-smoke",
            "archive-inspect-smoke",
            "cli-status-dashboard-shape-smoke"
          ],
          "description": "允许的 smoke case id；闭合 enum。v1 (/279e) 提供 sandbox-exec-printf / remember-ack-empty-fallback； 新增四个 AgentThursdayAgent stub 探针 (context-active-inspect-smoke / context-lifecycle-noop-smoke / compaction-plan-dry-run-smoke / archive-inspect-smoke)，验证  Step 6 free function 抽取的行为保留； 新增 cli-status-dashboard-shape-smoke，给 directed validation agent 一个安全的 /cli/status 等价 dashboard shape 探针（仅 read-only composition，不跑 sweepStaleDraftEnvelopes，不返回 raw payload）。"
        }
      },
      "required": [
        "case_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "ok",
            "blocked"
          ]
        },
        "case_id": {
          "type": "string"
        },
        "http_status": {
          "type": "integer"
        },
        "response": {
          "type": "object",
          "description": "Closed shape depends on case_id.\nsandbox-exec-printf → { stdout, stderr, exit_code, success,\n                         timed_out, sandbox_id, timeout_seconds }\nremember-ack-empty-fallback → { final_reply, fallback_applied }\nCard 287 cliStubProbe cases (context-active-inspect-smoke /\n                              context-lifecycle-noop-smoke /\n                              compaction-plan-dry-run-smoke /\n                              archive-inspect-smoke) → see\nper-case fields below; counts + boolean flags only, never raw\nmessage text, prompts, summaries, previews, query strings, or\ntraceIds.\nCard 303 cli-status-dashboard-shape-smoke → {\n  current_task_present, latest_envelope_present,\n  latest_outbox_present, patch_apply_outbox_present,\n  drift_flags_present, version_present, latest_outbox_kind,\n  patch_apply_outbox_kind, drift_flag_count, drift_flag_names,\n  version_fields_present }; presence booleans + closed-enum\nkinds + drift-flag whitelist names only. Raw outbox row,\npatch-apply payload, envelope id, marker, and shared secret\nare never returned.",
          "properties": {
            "stdout": {
              "type": "string"
            },
            "stderr": {
              "type": "string"
            },
            "exit_code": {
              "type": "integer"
            },
            "success": {
              "type": "boolean"
            },
            "timed_out": {
              "type": "boolean"
            },
            "sandbox_id": {
              "type": "string"
            },
            "timeout_seconds": {
              "type": "integer"
            },
            "final_reply": {
              "type": "string",
              "description": " — visible reply yielded by applyRememberAckFallback"
            },
            "fallback_applied": {
              "type": "boolean",
              "description": " — whether the predicate triggered the ack replacement"
            },
            "context_id_present": {
              "type": "boolean",
              "description": " context-active-inspect-smoke — registry.getActiveContextId() returned a non-empty contextId"
            },
            "total_message_count": {
              "type": "integer",
              "description": " context-active-inspect-smoke / compaction-plan-dry-run-smoke — snapshot total message count"
            },
            "visible_messages_count": {
              "type": "integer",
              "description": " context-active-inspect-smoke — inspect.visibleMessages.length"
            },
            "by_role_user": {
              "type": "integer",
              "description": " context-active-inspect-smoke"
            },
            "by_role_assistant": {
              "type": "integer",
              "description": " context-active-inspect-smoke"
            },
            "by_role_system": {
              "type": "integer",
              "description": " context-active-inspect-smoke"
            },
            "has_context_budget": {
              "type": "boolean",
              "description": " context-active-inspect-smoke — inspect.contextBudget object present"
            },
            "sanitized_at": {
              "type": "integer",
              "description": " context-active-inspect-smoke — inspect.sanitizedAt epoch ms"
            },
            "previous_context_id_present": {
              "type": "boolean",
              "description": " context-lifecycle-noop-smoke — switchContext returned a non-empty previousContextId"
            },
            "new_context_id_present": {
              "type": "boolean",
              "description": " context-lifecycle-noop-smoke"
            },
            "previous_equals_new": {
              "type": "boolean",
              "description": " context-lifecycle-noop-smoke — true means the no-op branch was hit"
            },
            "activated_at": {
              "type": "integer",
              "description": " context-lifecycle-noop-smoke — switchContext result activatedAt"
            },
            "plan_id_present": {
              "type": "boolean",
              "description": " compaction-plan-dry-run-smoke — compactPlan returned a planId"
            },
            "visible_start_index": {
              "type": "integer",
              "description": " compaction-plan-dry-run-smoke — snapshot.visibleStartIndex"
            },
            "ranges_count": {
              "type": "integer",
              "description": " compaction-plan-dry-run-smoke — plan.ranges.length (no previews exposed)"
            },
            "rejected_count": {
              "type": "integer",
              "description": " compaction-plan-dry-run-smoke — plan.rejected.length"
            },
            "preserved_count": {
              "type": "integer",
              "description": " compaction-plan-dry-run-smoke — plan.preserved.length"
            },
            "before_messages": {
              "type": "integer",
              "description": " compaction-plan-dry-run-smoke — plan.pressure.beforeMessages"
            },
            "estimated_after_messages": {
              "type": "integer",
              "description": " compaction-plan-dry-run-smoke — plan.pressure.estimatedAfterMessages"
            },
            "archive_chunk_total": {
              "type": "integer",
              "description": " archive-inspect-smoke — totals.archiveChunkTotal"
            },
            "archive_context_count": {
              "type": "integer",
              "description": " archive-inspect-smoke"
            },
            "flush_total": {
              "type": "integer",
              "description": " archive-inspect-smoke"
            },
            "flush_failed_total": {
              "type": "integer",
              "description": " archive-inspect-smoke"
            },
            "retrieval_total": {
              "type": "integer",
              "description": " archive-inspect-smoke"
            },
            "recent_flushes_count": {
              "type": "integer",
              "description": " archive-inspect-smoke — summary.recentFlushes.length"
            },
            "recent_retrievals_count": {
              "type": "integer",
              "description": " archive-inspect-smoke"
            },
            "counts_by_context_count": {
              "type": "integer",
              "description": " archive-inspect-smoke"
            },
            "generated_at": {
              "type": "integer",
              "description": " archive-inspect-smoke — summary.generatedAt epoch ms"
            },
            "current_task_present": {
              "type": "boolean",
              "description": " cli-status-dashboard-shape-smoke — DashboardSection.current_task present (always true on a healthy compose)"
            },
            "latest_envelope_present": {
              "type": "boolean",
              "description": " cli-status-dashboard-shape-smoke — DashboardSection.latest_envelope !== null"
            },
            "latest_outbox_present": {
              "type": "boolean",
              "description": " cli-status-dashboard-shape-smoke — DashboardSection.latest_outbox is the row object (not \"missing\"/\"unknown\" sentinel)"
            },
            "patch_apply_outbox_present": {
              "type": "boolean",
              "description": " cli-status-dashboard-shape-smoke — DashboardSection.patch_apply_outbox is the row object (not sentinel)"
            },
            "drift_flags_present": {
              "type": "boolean",
              "description": " cli-status-dashboard-shape-smoke — DashboardSection.drift_flags is Array.isArray"
            },
            "version_present": {
              "type": "boolean",
              "description": " cli-status-dashboard-shape-smoke — DashboardSection.version is an object"
            },
            "latest_outbox_kind": {
              "type": "string",
              "enum": [
                "row",
                "missing",
                "unknown"
              ],
              "description": " cli-status-dashboard-shape-smoke — discriminator for the latest_outbox union; row=object payload, missing=empty rows[], unknown=fail-soft from inspectOutbox throw"
            },
            "patch_apply_outbox_kind": {
              "type": "string",
              "enum": [
                "row",
                "missing",
                "unknown"
              ],
              "description": " cli-status-dashboard-shape-smoke — discriminator for the patch_apply_outbox union; unknown=fail-soft from getLatestPatchApplyOutboxSummary throw (also pushes patch_apply_outbox_unknown drift flag)"
            },
            "drift_flag_count": {
              "type": "integer",
              "description": " cli-status-dashboard-shape-smoke — dashboard.drift_flags.length (closed whitelist)"
            },
            "drift_flag_names": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": " cli-status-dashboard-shape-smoke — sorted closed-whitelist drift flag names; never includes any model-derived or free-form string"
            },
            "version_fields_present": {
              "type": "object",
              "description": " cli-status-dashboard-shape-smoke — per-field presence map for DashboardSection.version (instance_name, service_version, worker_version_id/tag/timestamp).  fail-soft means version_id/tag/timestamp may be false in local dev.",
              "properties": {
                "instance_name": {
                  "type": "boolean"
                },
                "service_version": {
                  "type": "boolean"
                },
                "worker_version_id": {
                  "type": "boolean"
                },
                "worker_version_tag": {
                  "type": "boolean"
                },
                "worker_version_timestamp": {
                  "type": "boolean"
                }
              }
            }
          }
        },
        "evidence": {
          "type": "object",
          "description": "Closed shape depends on case_id.\nsandbox-exec-printf → { stdout_bytes, stderr_bytes,\n                         truncated_stdout, truncated_stderr,\n                         redaction_applied }\nremember-ack-empty-fallback → { input_was_empty, ack_present,\n                                 final_reply_equals_ack }\nCard 287 cliStubProbe cases → { free_fn_path_exercised,\n                                 destructive_mutation:false,\n                                 <case-specific structural keys> }\nCard 303 cli-status-dashboard-shape-smoke → { dashboard_top_keys,\n                                               free_fn_path_exercised,\n                                               destructive_mutation:false }\nThe `free_fn_path_exercised` list names the free functions whose\nDO @callable / route-layer composer was invoked. The\n`destructive_mutation` flag is always `false` for /303\ncases by construction (no message clear, no archive write, no\nactive-pointer change, no compaction apply, and  also\ndoes not run the lazy `sweepStaleDraftEnvelopes` the real\n/cli/status fires).",
          "properties": {
            "stdout_bytes": {
              "type": "integer"
            },
            "stderr_bytes": {
              "type": "integer"
            },
            "truncated_stdout": {
              "type": "boolean"
            },
            "truncated_stderr": {
              "type": "boolean"
            },
            "redaction_applied": {
              "type": "boolean"
            },
            "input_was_empty": {
              "type": "boolean",
              "description": " — fixture replyText.length === 0"
            },
            "ack_present": {
              "type": "boolean",
              "description": " — fixture rememberAck is non-empty"
            },
            "final_reply_equals_ack": {
              "type": "boolean",
              "description": " — final_reply === rememberAck (PASS evidence)"
            },
            "free_fn_path_exercised": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": " — names of Step 6 free functions invoked via @callable delegate"
            },
            "destructive_mutation": {
              "type": "boolean",
              "description": " — always false; the probes never mutate message/archive/pointer state"
            },
            "inspect_top_keys": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": " context-active-inspect-smoke — sorted top-level keys returned by inspectContext (shape evidence; not values)"
            },
            "switch_was_noop": {
              "type": "boolean",
              "description": " context-lifecycle-noop-smoke — kind:\"noop\" branch confirmed (previousContextId === newContextId)"
            },
            "rejected_reasons": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": " compaction-plan-dry-run-smoke — sorted closed-enum reasons; `detail` strings (which could carry message ids) are NOT exposed"
            },
            "plan_strategy_keys": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": " compaction-plan-dry-run-smoke — sorted strategy field names (shape evidence; not values)"
            },
            "summary_top_keys": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": " archive-inspect-smoke — sorted top-level keys returned by getArchiveInspectSummary"
            },
            "dashboard_top_keys": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": " cli-status-dashboard-shape-smoke — sorted top-level keys returned by buildDashboardSectionFree (shape evidence; the closed key set is current_task / latest_envelope / latest_outbox / patch_apply_outbox / drift_flags / version)"
            }
          }
        },
        "blocked": {
          "type": "object",
          "properties": {
            "reason": {
              "type": "string",
              "enum": [
                "missing_secret_binding",
                "missing_sandbox_binding",
                "missing_agent_binding",
                "stub_call_failed",
                "auth_failed",
                "route_misconfigured"
              ]
            },
            "message": {
              "type": "string"
            }
          }
        }
      },
      "required": [
        "status",
        "case_id"
      ]
    },
    "side_effects": [
      "gate_execution"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.admin.smoke.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.admin.smoke.result",
        "when": "result"
      },
      {
        "name": "tool.admin.smoke.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "artifact.list",
    "description": "列出当前 agent workspace 上某个 card 已写入的所有 artifact envelope（不返回 body 内容）。card 目录不存在时返回 ok=true 且 envelopes=[]。",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/artifact/list"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "cardId": {
          "type": "string"
        }
      },
      "required": [
        "cardId"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "card_id": {
          "type": "string"
        },
        "envelopes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "envelope_version": {
                "type": "string"
              },
              "card_id": {
                "type": "string"
              },
              "type": {
                "type": "string"
              },
              "filename": {
                "type": "string"
              },
              "mime": {
                "type": "string"
              },
              "source_agent": {
                "type": "string"
              },
              "producer_user_id": {
                "type": "string"
              },
              "created_at": {
                "type": "string"
              },
              "sha256": {
                "type": "string"
              },
              "size_bytes": {
                "type": "integer"
              },
              "transport": {
                "type": "string"
              },
              "transport_uri": {
                "type": "string"
              },
              "notes": {
                "type": "string"
              }
            },
            "required": [
              "envelope_version",
              "card_id",
              "type",
              "filename",
              "mime",
              "source_agent",
              "created_at",
              "sha256",
              "size_bytes",
              "transport",
              "transport_uri"
            ]
          }
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "none"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.artifact.list.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.artifact.list.result",
        "when": "result"
      },
      {
        "name": "tool.artifact.list.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "artifact.read",
    "description": "读回先前 artifact.write 写入的工件，返回 envelope（sha256 / size_bytes / transport_uri）和 UTF-8 content；找不到 envelope 或 body 时返回 ok=false / not_found。仅访问当前 agent workspace 的 tmp/artifact/<card_id>/<filename>。",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/artifact/read"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "cardId": {
          "type": "string"
        },
        "filename": {
          "type": "string"
        }
      },
      "required": [
        "cardId",
        "filename"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "envelope": {
          "type": "object",
          "properties": {
            "envelope_version": {
              "type": "string"
            },
            "card_id": {
              "type": "string"
            },
            "type": {
              "type": "string"
            },
            "filename": {
              "type": "string"
            },
            "mime": {
              "type": "string"
            },
            "source_agent": {
              "type": "string"
            },
            "producer_user_id": {
              "type": "string"
            },
            "created_at": {
              "type": "string"
            },
            "sha256": {
              "type": "string"
            },
            "size_bytes": {
              "type": "integer"
            },
            "transport": {
              "type": "string"
            },
            "transport_uri": {
              "type": "string"
            },
            "notes": {
              "type": "string"
            }
          },
          "required": [
            "envelope_version",
            "card_id",
            "type",
            "filename",
            "mime",
            "source_agent",
            "created_at",
            "sha256",
            "size_bytes",
            "transport",
            "transport_uri"
          ]
        },
        "content": {
          "type": "string"
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "none"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.artifact.read.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.artifact.read.result",
        "when": "result"
      },
      {
        "name": "tool.artifact.read.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "artifact.write",
    "description": "把一个文本工件（patch / test_doc / smoke_json / completion_report）写入当前 agent workspace 的 tmp/artifact/<card_id>/<filename>，返回 envelope（sha256 / size_bytes / transport_uri）。仅接受 245c 允许的类型与 MIME，会做 traversal / size / secret 校验，拒绝时返回 ok=false。",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/artifact/write"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "cardId": {
          "type": "string"
        },
        "filename": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "enum": [
            "patch",
            "test_doc",
            "smoke_json",
            "completion_report"
          ]
        },
        "sourceAgent": {
          "type": "string",
          "enum": [
            "",
            "",
            "",
            "verifier"
          ]
        },
        "producerUserId": {
          "type": "string"
        },
        "mime": {
          "type": "string"
        },
        "notes": {
          "type": "string"
        },
        "content": {
          "type": "string"
        }
      },
      "required": [
        "cardId",
        "filename",
        "type",
        "sourceAgent",
        "content"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "envelope": {
          "type": "object",
          "properties": {
            "envelope_version": {
              "type": "string"
            },
            "card_id": {
              "type": "string"
            },
            "type": {
              "type": "string"
            },
            "filename": {
              "type": "string"
            },
            "mime": {
              "type": "string"
            },
            "source_agent": {
              "type": "string"
            },
            "producer_user_id": {
              "type": "string"
            },
            "created_at": {
              "type": "string"
            },
            "sha256": {
              "type": "string"
            },
            "size_bytes": {
              "type": "integer"
            },
            "transport": {
              "type": "string"
            },
            "transport_uri": {
              "type": "string"
            },
            "notes": {
              "type": "string"
            }
          },
          "required": [
            "envelope_version",
            "card_id",
            "type",
            "filename",
            "mime",
            "source_agent",
            "created_at",
            "sha256",
            "size_bytes",
            "transport",
            "transport_uri"
          ]
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            },
            "pattern": {
              "type": "string"
            },
            "cap": {
              "type": "integer"
            },
            "size": {
              "type": "integer"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "idempotency_key": {
      "shape": "inputs_hash",
      "fields": [
        "cardId",
        "filename",
        "content"
      ]
    },
    "dry_run_supported": false,
    "tier": 3,
    "emit_events": [
      {
        "name": "tool.artifact.write.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.artifact.write.result",
        "when": "result"
      },
      {
        "name": "tool.artifact.write.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      },
      {
        "field": "evidence.envelope.sha256",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "localdoc.convert_text",
    "description": "Convert markdown content into a LocalDoc hosted page. Returns non-sensitive evidence (id / url / markdownUrl / status); never returns the api key.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/localdoc/convert_text"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "content": {
          "type": "string"
        }
      },
      "required": [
        "content"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "status": {
          "enum": [
            "ok",
            "blocked",
            "failed"
          ]
        },
        "id": {
          "type": "string"
        },
        "url": {
          "type": "string"
        },
        "markdownUrl": {
          "type": "string"
        },
        "http_status": {
          "type": "integer"
        },
        "reason": {
          "type": "string"
        },
        "error_message": {
          "type": "string"
        }
      },
      "required": [
        "status"
      ]
    },
    "side_effects": [
      "network_call"
    ],
    "idempotency_key": {
      "shape": "inputs_hash",
      "fields": [
        "title",
        "content"
      ]
    },
    "dry_run_supported": false,
    "tier": 3,
    "emit_events": [
      {
        "name": "tool.localdoc.convert_text.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.localdoc.convert_text.result",
        "when": "result"
      },
      {
        "name": "tool.localdoc.convert_text.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      },
      {
        "field": "evidence.network_response_status",
        "required": true
      }
    ],
    "implemented": true,
    "env_binding": "LOCALDOC_API_KEY"
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.agent_create",
    "description": "Create a new cloud agent on the registry DO. Validates model (must be runnable in this build) and skillset (must be in embedded ∪ custom). Returns the persisted agent row with agent_id. Fails with name_conflict / unknown_model / unsupported_model / unknown_skillset; never overwrites an existing agent.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/agent_create"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "model": {
          "type": "string"
        },
        "skillset": {
          "type": "string"
        },
        "persona": {
          "type": "string",
          "description": "Free-form persona prefix prepended to the agent system prompt. Empty string permitted."
        },
        "channel": {
          "type": "string",
          "description": "Optional inbound channel hint (e.g. \"discord\"). Defaults handled server-side."
        },
        "status": {
          "type": "string",
          "enum": [
            "initialized",
            "archived",
            "deleted_marker"
          ],
          "description": "Initial lifecycle status (ADR 2026-05-26 four-layer model). Defaults to \"initialized\"; use accepts_tasks=false separately to park an agent without archiving."
        }
      },
      "required": [
        "name",
        "model",
        "skillset"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "agent": {
          "type": "object",
          "properties": {
            "agent_id": {
              "type": "string"
            },
            "id": {
              "type": "string",
              "description": "Legacy alias; same value as agent_id."
            },
            "name": {
              "type": "string"
            },
            "model": {
              "type": "string"
            },
            "channel": {
              "type": "string"
            },
            "skillset": {
              "type": "string"
            },
            "persona": {
              "type": "string"
            },
            "status": {
              "type": "string"
            },
            "created_at": {
              "type": "string"
            },
            "updated_at": {
              "type": "string"
            }
          },
          "required": [
            "agent_id",
            "name",
            "model",
            "skillset",
            "status",
            "created_at",
            "updated_at"
          ]
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "validation_failed",
                "name_conflict",
                "unknown_model",
                "unsupported_model",
                "unknown_skillset",
                "internal"
              ]
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "idempotency_key": {
      "shape": "inputs_hash",
      "fields": [
        "name"
      ]
    },
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.manager.agent_create.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.agent_create.result",
        "when": "result"
      },
      {
        "name": "tool.manager.agent_create.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      },
      {
        "field": "evidence.agent_id",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.agent_list",
    "description": "List active-roster agents from the registry DO (default excludes `archived` + `deleted_marker` per ADR §2.1; pass include_archived=true to see both tombstone states). Returns agent_id-keyed rows with name / model / channel / skillset / status / created_at / updated_at. Use this before agent_create or agent_update to avoid name collisions and to discover the target agent_id.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/agent_list"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "include_archived": {
          "type": "boolean",
          "description": "When true, include both `status==\"archived\"` and `status==\"deleted_marker\"` rows alongside the active roster (operator/inspect escape hatch). Defaults to false."
        }
      },
      "required": []
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "agents": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "agent_id": {
                "type": "string"
              },
              "id": {
                "type": "string",
                "description": "Legacy alias; same value as agent_id."
              },
              "name": {
                "type": "string"
              },
              "model": {
                "type": "string"
              },
              "channel": {
                "type": "string"
              },
              "skillset": {
                "type": "string"
              },
              "status": {
                "type": "string"
              },
              "created_at": {
                "type": "string"
              },
              "updated_at": {
                "type": "string"
              }
            },
            "required": [
              "agent_id",
              "name",
              "model",
              "skillset",
              "status"
            ]
          }
        },
        "count": {
          "type": "integer"
        }
      },
      "required": [
        "agents",
        "count"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 1,
    "emit_events": [
      {
        "name": "tool.manager.agent_list.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.agent_list.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.agent_message",
    "description": "Send a work message to a specific cloud agent by agent_id. Routes through the per-agent DO (agent-centric /355). Returns structured evidence with target agent_id, task_id, conversation_id, and either visible reply text (status \"replied\") or accepted/failed status. Never falls back to a global active agent.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/agent_message"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "agent_id": {
          "type": "string"
        },
        "text": {
          "type": "string"
        },
        "conversation_id": {
          "type": "string",
          "description": "Optional. When supplied, ties the message into an existing conversation thread."
        },
        "source": {
          "type": "string",
          "description": "Optional free-form label identifying the manager surface (e.g. \"manager.dispatch\", \"manager.http\"). Recorded in event payload only; never echoed to target agent."
        },
        "task_context": {
          "type": "object",
          "description": " / ADR §5 — optional structured TaskContext. When present, the manager\nrecords the full object on the `manager.agent_message.sent` event payload and\nthe subagent's first-turn user message receives a `<task-context>...</task-context>`\nfenced JSON block. `objective` is authoritative over conflicting prose; the\noriginal `text` is preserved verbatim. Limits: title ≤100, objective ≤500,\nverification_hint ≤500.\n\nCard 363 current-manager fallback — when the calling manager has an in-flight\n`submitManagerTask` round:\n  - if `parent_task_id` is missing/null, the adapter fills it with the\n    current outer `manager_task_id` (= registry `event_log.trace_id` and\n    the `GET /api/manager/tasks/:task_id` task_id) so subagent dispatches\n    inherit the canonical id by default.\n  - if `source_agent_id` is missing, the adapter fills it with the calling\n    manager's `agent_id`.\n  - explicit non-empty values are NEVER overridden — pass an explicit\n    `parent_task_id` to dispatch under a different parent (e.g. cross-chain\n    or testing).\nThe merged `task_context` is then strict-revalidated against the canonical\nschema; an unfilled `id`/`title`/`objective` surfaces as\n`status:\"failed\" reason:\"invalid_input\"` rather than a silent drop.",
          "properties": {
            "id": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "objective": {
              "type": "string"
            },
            "source_agent_id": {
              "type": "string"
            },
            "house_rules": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "parent_task_id": {
              "type": "string"
            },
            "card_id": {
              "type": "string"
            },
            "artifact_refs": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "agent_id": {
                    "type": "string"
                  },
                  "task_id": {
                    "type": "string"
                  },
                  "artifact_id": {
                    "type": "string"
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "summary",
                      "file",
                      "diff",
                      "log",
                      "trace"
                    ]
                  },
                  "digest": {
                    "type": "string"
                  }
                },
                "required": [
                  "agent_id",
                  "task_id",
                  "artifact_id",
                  "kind"
                ]
              }
            },
            "expected_outputs": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "non_goals": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "verification_hint": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "title",
            "objective"
          ]
        }
      },
      "required": [
        "agent_id",
        "text"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "status": {
          "type": "string",
          "enum": [
            "replied",
            "accepted",
            "failed"
          ]
        },
        "agent_id": {
          "type": "string"
        },
        "task_id": {
          "type": "string"
        },
        "conversation_id": {
          "type": "string"
        },
        "envelope_id": {
          "type": "string",
          "description": "/355 envelope id when the loop completed."
        },
        "reply": {
          "type": "string",
          "description": "Visible reply text when status == \"replied\"."
        },
        "loop_triggered": {
          "type": "boolean",
          "description": "True iff the target agent loop completed at least one step."
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "invalid_input",
                "target_not_found",
                "agent_not_found",
                "agent_loop_timeout",
                "internal"
              ]
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok",
        "status",
        "agent_id"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 3,
    "emit_events": [
      {
        "name": "tool.manager.agent_message.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.agent_message.result",
        "when": "result"
      },
      {
        "name": "tool.manager.agent_message.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      },
      {
        "field": "evidence.agent_id",
        "required": true
      },
      {
        "field": "evidence.task_id",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.agent_update",
    "description": "Update a subset of an agent's fields (name / model / skillset / persona / status). Returns the updated agent row. Fails with not_found / name_conflict / unknown_model / unsupported_model / unknown_skillset / no_changes; never auto-creates the agent and never renames the underlying DO instance.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/agent_update"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "agent_id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "model": {
          "type": "string"
        },
        "skillset": {
          "type": "string"
        },
        "persona": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "initialized",
            "archived",
            "deleted_marker"
          ],
          "description": "Lifecycle status (ADR 2026-05-26 four-layer model). Set to \"archived\" to remove from active roster (reversible) or \"deleted_marker\" for audit tombstone."
        }
      },
      "required": [
        "agent_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "agent": {
          "type": "object",
          "properties": {
            "agent_id": {
              "type": "string"
            },
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "model": {
              "type": "string"
            },
            "channel": {
              "type": "string"
            },
            "skillset": {
              "type": "string"
            },
            "persona": {
              "type": "string"
            },
            "status": {
              "type": "string"
            },
            "created_at": {
              "type": "string"
            },
            "updated_at": {
              "type": "string"
            }
          },
          "required": [
            "agent_id",
            "name",
            "model",
            "skillset",
            "status",
            "updated_at"
          ]
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "validation_failed",
                "not_found",
                "name_conflict",
                "unknown_model",
                "unsupported_model",
                "unknown_skillset",
                "no_changes",
                "internal"
              ]
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.manager.agent_update.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.agent_update.result",
        "when": "result"
      },
      {
        "name": "tool.manager.agent_update.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      },
      {
        "field": "evidence.agent_id",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.skillset_create",
    "description": "Create a custom skillset on the registry DO. Manifest is canonicalized and validated; embedded ids are rejected; only known tool ids can be referenced. Returns the persisted row; never overwrites an existing id.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/skillset_create"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Optional. If supplied, must match manifest.id; if omitted, manifest.id is used."
        },
        "manifest": {
          "type": "object",
          "description": "Structured SkillsetManifest body. Required fields - id / name / description / version / purpose / tools (string[]) / skills (each with id / name / tier:1-5 / tools:string[])."
        }
      },
      "required": [
        "manifest"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "skillset": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "version": {
              "type": "string"
            },
            "source": {
              "type": "string",
              "enum": [
                "custom"
              ]
            },
            "tools": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "skill_ids": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "created_at": {
              "type": "string"
            },
            "updated_at": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "name",
            "version",
            "source",
            "tools",
            "skill_ids",
            "created_at",
            "updated_at"
          ]
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "validation_failed",
                "manifest_required",
                "manifest_invalid_shape",
                "missing_id",
                "id_mismatch",
                "embedded_skillset_readonly",
                "unknown_tool_id",
                "id_conflict",
                "internal"
              ]
            },
            "message": {
              "type": "string"
            },
            "field": {
              "type": "string"
            },
            "tool_id": {
              "type": "string"
            },
            "id": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "idempotency_key": {
      "shape": "inputs_hash",
      "fields": [
        "manifest"
      ]
    },
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.manager.skillset_create.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.skillset_create.result",
        "when": "result"
      },
      {
        "name": "tool.manager.skillset_create.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      },
      {
        "field": "evidence.skillset_id",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.skillset_list",
    "description": "List embedded ∪ custom skillsets. Returns id / name / description / version / source (\"embedded\"|\"custom\") / tool_count / skill_count. Embedded entries are readonly; custom entries can be updated via manager.skillset_update.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/skillset_list"
    },
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "skillsets": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "version": {
                "type": "string"
              },
              "source": {
                "type": "string",
                "enum": [
                  "embedded",
                  "custom"
                ]
              },
              "status": {
                "type": "string",
                "enum": [
                  "loaded",
                  "rejected",
                  "unknown"
                ],
                "description": "Runtime snapshot status; \"unknown\" when the loader has not yet inspected this id (custom row added since last reload)."
              },
              "tool_count": {
                "type": "integer"
              },
              "skill_count": {
                "type": "integer"
              },
              "created_at": {
                "type": "string",
                "description": "Custom skillsets only; embedded entries omit this field."
              },
              "updated_at": {
                "type": "string",
                "description": "Custom skillsets only; embedded entries omit this field."
              }
            },
            "required": [
              "id",
              "name",
              "version",
              "source",
              "tool_count",
              "skill_count"
            ]
          }
        },
        "count": {
          "type": "integer"
        }
      },
      "required": [
        "skillsets",
        "count"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 1,
    "emit_events": [
      {
        "name": "tool.manager.skillset_list.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.skillset_list.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.skillset_read",
    "description": "Read a single skillset by id. Returns manifest body, loader status (loaded / rejected with reason), tool ids, skill ids, and source (\"embedded\"|\"custom\"). 404 (status:\"failed\", reason:\"not_found\") when the id is in neither registry.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/skillset_read"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "skillset_id": {
          "type": "string"
        }
      },
      "required": [
        "skillset_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "ok",
            "failed"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "not_found",
            "invalid_input",
            "internal"
          ]
        },
        "source": {
          "type": "string",
          "enum": [
            "embedded",
            "custom"
          ]
        },
        "loader_status": {
          "type": "string",
          "enum": [
            "loaded",
            "rejected",
            "unknown"
          ]
        },
        "rejected_reason": {
          "type": "string",
          "description": "Present iff loader_status == \"rejected\"; never includes raw file bytes."
        },
        "skillset": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "version": {
              "type": "string"
            },
            "purpose": {
              "type": "string"
            },
            "tools": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "skill_ids": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "manifest": {
              "type": "object",
              "description": "Full canonical SkillsetManifest body (already-canonicalized; safe to echo — contains no secrets)."
            },
            "created_at": {
              "type": "string"
            },
            "updated_at": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "name",
            "version",
            "tools",
            "skill_ids"
          ]
        }
      },
      "required": [
        "status"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 1,
    "emit_events": [
      {
        "name": "tool.manager.skillset_read.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.skillset_read.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.skillset_update",
    "description": "Update a custom skillset by id. Embedded ids rejected with embedded_skillset_readonly; unknown tool ids rejected with unknown_tool_id; no_changes returned when the supplied manifest matches the stored row. Returns the updated row.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/skillset_update"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "skillset_id": {
          "type": "string",
          "description": "URL-level id; must match manifest.id."
        },
        "manifest": {
          "type": "object",
          "description": "Full canonical manifest body (same shape as create)."
        }
      },
      "required": [
        "skillset_id",
        "manifest"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "skillset": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "version": {
              "type": "string"
            },
            "source": {
              "type": "string",
              "enum": [
                "custom"
              ]
            },
            "tools": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "skill_ids": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "created_at": {
              "type": "string"
            },
            "updated_at": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "name",
            "version",
            "source",
            "tools",
            "skill_ids",
            "updated_at"
          ]
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "validation_failed",
                "manifest_required",
                "manifest_invalid_shape",
                "missing_id",
                "id_mismatch",
                "embedded_skillset_readonly",
                "unknown_tool_id",
                "not_found",
                "no_changes",
                "internal"
              ]
            },
            "message": {
              "type": "string"
            },
            "field": {
              "type": "string"
            },
            "tool_id": {
              "type": "string"
            },
            "id": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.manager.skillset_update.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.skillset_update.result",
        "when": "result"
      },
      {
        "name": "tool.manager.skillset_update.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      },
      {
        "field": "evidence.skillset_id",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.subagent_summaries",
    "description": "Read subagent summaries for parent tasks the calling manager has dispatched. Returns bounded list of summaries with artifact_refs, reply_excerpt (≤500 UTF-8 bytes), completed_at, task_id, and agent_id. Filter by parent_task_id and/or source_agent_id; limit defaults to 20, capped at 50. Permission boundary, cross-manager queries get an empty list.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/subagent_summaries"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "parent_task_id": {
          "type": "string",
          "description": "When provided, restrict results to summaries keyed by this parent task id (typically the manager's own outer task id)."
        },
        "source_agent_id": {
          "type": "string",
          "description": "When provided, restrict to summaries whose source_agent_id matches. The permission boundary still applies first."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "description": "Maximum number of summaries to return (default 20, cap 50)."
        }
      },
      "required": []
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "summaries": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "task_id": {
                "type": "string"
              },
              "agent_id": {
                "type": "string"
              },
              "parent_task_id": {
                "type": "string"
              },
              "source_agent_id": {
                "type": "string"
              },
              "artifact_refs": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "agent_id": {
                      "type": "string"
                    },
                    "task_id": {
                      "type": "string"
                    },
                    "artifact_id": {
                      "type": "string"
                    },
                    "kind": {
                      "type": "string"
                    },
                    "digest": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "agent_id",
                    "task_id",
                    "artifact_id",
                    "kind"
                  ]
                }
              },
              "reply_excerpt": {
                "type": "string"
              },
              "completed_at": {
                "type": "string"
              }
            },
            "required": [
              "task_id",
              "agent_id",
              "parent_task_id",
              "source_agent_id",
              "artifact_refs",
              "reply_excerpt",
              "completed_at"
            ]
          }
        },
        "count": {
          "type": "integer"
        }
      },
      "required": [
        "ok",
        "summaries",
        "count"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 1,
    "emit_events": [
      {
        "name": "tool.manager.subagent_summaries.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.subagent_summaries.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.task_complete",
    "description": "Emit a `manager.task.completed` event recording the manager's structured completion report for a parent task (verdict, summary, optional evidence/next_step/card_ref). Coexists with `manager.task.replied`; does NOT change  status derivation. `completion_verdict=success` requires a prior `manager.task.merged` row for the same parent_task_id unless `allow_without_merge=true` plus a non-empty `allow_without_merge_reason` is supplied. `manager_agent_id` is derived from the calling agent_id; not accepted from input. `summary` is bounded at 2000 UTF-8 bytes.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/task_complete"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "parent_task_id": {
          "type": "string",
          "description": "The manager's outer task id. Used as `event_log.trace_id` so the completion event sits in the same task-keyed stream as received/started/replied/failed/merged."
        },
        "completion_verdict": {
          "type": "string",
          "enum": [
            "success",
            "partial",
            "failed"
          ],
          "description": "Manager's verdict on the parent task. `success` default-requires a prior `manager.task.merged` event (override via `allow_without_merge`). `partial` / `failed` skip the merge precondition entirely."
        },
        "summary": {
          "type": "string",
          "description": "Human-readable completion note. Capped at 2000 UTF-8 bytes (TextEncoder, NOT JS string.length). Multi-byte CJK / emoji is counted correctly. Do NOT paste raw secrets, full prompts, or full subagent replies through this field."
        },
        "evidence": {
          "type": "object",
          "description": "Optional pointers to underlying audit rows. Shape is validated when provided; values are NOT cross-checked against actual event rows in v1.",
          "properties": {
            "merge_event_id": {
              "type": "integer",
              "minimum": 0,
              "description": "Optional pointer to the `manager.task.merged` `event_log.id` row this completion is anchored to."
            },
            "subagent_task_ids": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Optional list of subagent task ids whose work this completion covers. Each entry must be a non-empty string."
            },
            "envelope_id": {
              "type": "string",
              "description": "Optional envelope id of the manager's final reply (corresponds to `manager.task.replied.payload.envelope_id`)."
            }
          }
        },
        "next_step": {
          "type": "string",
          "description": "Optional short next-step hint for the operator (e.g. \"submit PR to main\"). Non-empty when present."
        },
        "card_ref": {
          "type": "object",
          "description": "Optional pointer back to the kanban card this completion closes. Shape is validated when provided.",
          "properties": {
            "card_id": {
              "type": "string",
              "description": "Card id (e.g. \"377\"). Non-empty when card_ref is provided."
            },
            "path": {
              "type": "string",
              "description": "Optional kanban path (e.g. \"\"). Non-empty when provided."
            }
          },
          "required": [
            "card_id"
          ]
        },
        "allow_without_merge": {
          "type": "boolean",
          "description": "When true, bypasses the `success` requires `manager.task.merged` precondition. Requires `allow_without_merge_reason` to be supplied with a non-empty value (gated as `validation_failed`)."
        },
        "allow_without_merge_reason": {
          "type": "string",
          "description": "Required when `allow_without_merge=true`. Free-form rationale stored on the completion payload so auditors can review the bypass."
        },
        "completed_at": {
          "type": "string",
          "description": "Optional ISO timestamp override. Production callers should omit and let the helper auto-fill. Accepted for deterministic test smokes."
        }
      },
      "required": [
        "parent_task_id",
        "completion_verdict",
        "summary"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "task_id": {
          "type": "string",
          "description": "Echoes `parent_task_id` for parity with other task-keyed tool outputs."
        },
        "parent_task_id": {
          "type": "string"
        },
        "completion_verdict": {
          "type": "string",
          "enum": [
            "success",
            "partial",
            "failed"
          ]
        },
        "completed_at": {
          "type": "string"
        },
        "payload": {
          "type": "object",
          "description": "Full `ManagerTaskCompletedPayload` echoed for inspect/debug. Shape matches the event written to event_log."
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "validation_failed"
              ]
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "manager.task.completed",
        "when": "result"
      },
      {
        "name": "tool.manager.task_complete.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.task_complete.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.task_merge",
    "description": "Emit an audit-grade `manager.task.merged` event for a parent manager task. Records structured `subagent_task_refs` (task_id, agent_id, summary_id, verdict) plus the manager's overall `merge_verdict`. Permission boundary, each summary_id must belong to a `manager.subagent.summary` row addressed to the calling manager. Coexists with `manager.task.replied`; does NOT change  status derivation. Zero-ref merges are legal ONLY with `merge_verdict=partial` or `merge_verdict=failed` (); zero-ref + `success` is rejected as `validation_failed`.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/task_merge"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "parent_task_id": {
          "type": "string",
          "description": "The manager's outer task id. Used as `event_log.trace_id` so the merge event sits in the same task-keyed stream as received/started/replied."
        },
        "subagent_task_refs": {
          "type": "array",
          "description": "One entry per subagent summary the manager is merging. Empty array is permitted as an audit-only zero-ref merge, but ONLY with `merge_verdict=partial` or `merge_verdict=failed` (); zero-ref + `merge_verdict=success` is rejected as `validation_failed`.",
          "items": {
            "type": "object",
            "properties": {
              "task_id": {
                "type": "string",
                "description": "Subagent task id (matches `manager.subagent.summary.payload.task_id`)."
              },
              "agent_id": {
                "type": "string",
                "description": "Subagent agent id that emitted the summary."
              },
              "summary_id": {
                "type": "string",
                "description": "v1 semantic — equals the subagent's `task_id`. Will become the underlying `event_log.id` row when  lands."
              },
              "verdict": {
                "type": "string",
                "enum": [
                  "success",
                  "partial",
                  "failed",
                  "ignored"
                ],
                "description": "Per-subagent verdict in the manager's merge."
              },
              "superseded_by": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "Optional pointer to a successor task/summary that subsumes this one. Defaults to null when omitted."
              },
              "reason": {
                "type": "string",
                "description": "Optional short rationale for the per-ref verdict (e.g. \"partial — only artifact A landed\")."
              }
            },
            "required": [
              "task_id",
              "agent_id",
              "summary_id",
              "verdict"
            ]
          }
        },
        "merge_verdict": {
          "type": "string",
          "enum": [
            "success",
            "partial",
            "failed"
          ],
          "description": "Manager's overall verdict across the included refs."
        },
        "note": {
          "type": "string",
          "description": "Optional free-form audit note (e.g. why a zero-ref merge happened)."
        },
        "merged_at": {
          "type": "string",
          "description": "Optional ISO timestamp override. Production callers should omit and let the helper auto-fill. Accepted for deterministic test smokes."
        }
      },
      "required": [
        "parent_task_id",
        "subagent_task_refs",
        "merge_verdict"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "task_id": {
          "type": "string",
          "description": "Echoes `parent_task_id` for parity with other task-keyed tool outputs."
        },
        "parent_task_id": {
          "type": "string"
        },
        "merge_verdict": {
          "type": "string",
          "enum": [
            "success",
            "partial",
            "failed"
          ]
        },
        "subagent_count": {
          "type": "integer",
          "description": "Number of refs accepted into the merge (post-validation)."
        },
        "merged_at": {
          "type": "string"
        },
        "payload": {
          "type": "object",
          "description": "Full `ManagerTaskMergedPayload` echoed for inspect/debug. Shape matches the audit event written to event_log."
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "validation_failed",
                "permission_denied",
                "summary_not_found",
                "ref_mismatch"
              ]
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 1,
    "emit_events": [
      {
        "name": "manager.task.merged",
        "when": "result"
      },
      {
        "name": "tool.manager.task_merge.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.task_merge.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.workflow_execute",
    "description": "Validate a declarative workflow descriptor (phases / agents / dependencies / caps) and start it on the durable workflow executor. Returns {run_id, workflow_instance_id, order, total_agents} on success or {ok:false, errors[]} on validation failure (fix the descriptor and retry). Execution is async — poll manager.workflow_status with the returned run_id.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/workflow_execute"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "descriptor": {
          "type": "object",
          "description": "Workflow descriptor. Shape — {descriptor_id, name, caps?{max_agents?, max_concurrency?}, phases[]{phase_id, name, depends_on_phase_ids?, agents[]{agent_id, prompt, role?}}}. Every agent_id must be an existing agent; prompts must be self-contained (no cross-phase variable piping in v1)."
        }
      },
      "required": [
        "descriptor"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "run_id": {
          "type": "string"
        },
        "workflow_instance_id": {
          "type": "string"
        },
        "order": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "total_agents": {
          "type": "integer"
        },
        "errors": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 3,
    "emit_events": [
      {
        "name": "tool.manager.workflow_execute.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.workflow_execute.result",
        "when": "result"
      },
      {
        "name": "tool.manager.workflow_execute.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.workflow_list",
    "description": "List saved named workflows (name, version, phase_count, agent_count, updated_at). Bounded to 100 most recently updated. Read-only.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/workflow_list"
    },
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "workflows": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "version": {
                "type": "integer"
              },
              "phase_count": {
                "type": "integer"
              },
              "agent_count": {
                "type": "integer"
              },
              "updated_at": {
                "type": "string"
              }
            },
            "required": [
              "name",
              "version",
              "phase_count",
              "agent_count",
              "updated_at"
            ]
          }
        },
        "count": {
          "type": "integer"
        }
      },
      "required": [
        "ok",
        "workflows",
        "count"
      ]
    },
    "side_effects": [
      "none"
    ],
    "dry_run_supported": false,
    "tier": 1,
    "emit_events": [
      {
        "name": "tool.manager.workflow_list.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.workflow_list.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.workflow_run_named",
    "description": "Run a saved named workflow. Substitutes {{args.key}} placeholders in agent prompts from the args map (all values strings); missing placeholder args fail fast with the full missing list. Returns the same shape as manager.workflow_execute plus {name, version}. Execution is async — poll manager.workflow_status.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/workflow_run_named"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Saved workflow name (see manager.workflow_list)."
        },
        "args": {
          "type": "object",
          "description": "String map filling {{args.key}} placeholders in agent prompts. Extra keys are ignored; missing keys error."
        }
      },
      "required": [
        "name"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "run_id": {
          "type": "string"
        },
        "workflow_instance_id": {
          "type": "string"
        },
        "order": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "total_agents": {
          "type": "integer"
        },
        "name": {
          "type": "string"
        },
        "version": {
          "type": "integer"
        },
        "errors": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "missing_args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 3,
    "emit_events": [
      {
        "name": "tool.manager.workflow_run_named.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.workflow_run_named.result",
        "when": "result"
      },
      {
        "name": "tool.manager.workflow_run_named.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.workflow_save",
    "description": "Save a workflow descriptor under a kebab-case name (max 64 chars) for later re-running. The descriptor is validated with the same rules as manager.workflow_execute before persisting; agent prompts may contain {{args.key}} placeholders to be filled at run time. Re-saving an existing name increments its version. Returns {ok, name, version} or {ok:false, errors[]}.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/workflow_save"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "kebab-case workflow name, e.g. \"proof-page-iteration\"."
        },
        "descriptor": {
          "type": "object",
          "description": "Workflow descriptor (same shape as manager.workflow_execute input)."
        }
      },
      "required": [
        "name",
        "descriptor"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "name": {
          "type": "string"
        },
        "version": {
          "type": "integer"
        },
        "errors": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "local_state"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.manager.workflow_save.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.workflow_save.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "manager.workflow_status",
    "description": "Read the workflow run ledger tree (run → phases → agents, with statuses, prompt previews, result summaries, failure reasons) for a run_id returned by manager.workflow_execute. Agents reach terminal states replied/failed; the run reaches completed/failed. Unknown run_id returns ok:false code:not_found.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/manager/workflow_status"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "description": "Workflow run id (e.g. wfr-exec-1a2b3c4d)."
        }
      },
      "required": [
        "run_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "run": {
          "type": "object",
          "description": "Run tree — run fields at the top level plus phases[] each with agents[]."
        },
        "code": {
          "type": "string"
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "none"
    ],
    "dry_run_supported": false,
    "tier": 1,
    "emit_events": [
      {
        "name": "tool.manager.workflow_status.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.manager.workflow_status.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "patch.validate",
    "description": "把 248 的 validate-only patch sandbox loop 暴露为 dynamic tool。输入 patchText 或 artifact ref (cardId+filename)；返回 PatchValidationResult（hunkAudit / gitApplyCheckOk / newFileEofOk / gateExitCode / failureReason 等闭合字段）。在 Cloudflare Sandbox 的 ephemeral /tmp/pv-<id> 里跑 git init / apply --check / apply / 新文件 EOF 校验 / 可选 node --check gate；hunk-count 审计在 Worker 内先跑一道 243-class 兜底。绝不 commit / push / deploy / 写实仓。",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/patch/validate"
    },
    "input_schema": {
      "type": "object",
      "properties": {
        "cardId": {
          "type": "string",
          "description": "artifact-ref part — card id under which the patch artifact was written via artifact.write"
        },
        "filename": {
          "type": "string",
          "description": "artifact-ref part — filename of the patch artifact"
        },
        "patchText": {
          "type": "string",
          "description": "inline patch text (unified diff). Mutually exclusive with the artifact-ref pair (one or the other; ref preferred for sha256 evidence)"
        },
        "gate": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "node_check"
              ]
            },
            "file": {
              "type": "string",
              "description": "file path inside the patch (will be validated against changedPaths shape)"
            }
          },
          "required": [
            "kind",
            "file"
          ]
        }
      }
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "result": {
          "type": "object",
          "properties": {
            "ok": {
              "type": "boolean"
            },
            "baseRevision": {
              "type": "string"
            },
            "changedPaths": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "hunkAudit": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "hunkIndex": {
                    "type": "integer"
                  },
                  "filePath": {
                    "type": "string"
                  },
                  "declaredOldCount": {
                    "type": "integer"
                  },
                  "declaredNewCount": {
                    "type": "integer"
                  },
                  "actualOldCount": {
                    "type": "integer"
                  },
                  "actualNewCount": {
                    "type": "integer"
                  },
                  "ok": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "hunkIndex",
                  "filePath",
                  "declaredOldCount",
                  "declaredNewCount",
                  "actualOldCount",
                  "actualNewCount",
                  "ok"
                ]
              }
            },
            "gitApplyCheckOk": {
              "type": "boolean"
            },
            "gitApplyCheckStderr": {
              "type": "string"
            },
            "newFileEofOk": {
              "type": "boolean"
            },
            "newFileEofDetails": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "gateCommand": {
              "type": "string"
            },
            "gateExitCode": {
              "type": "integer"
            },
            "gateStderr": {
              "type": "string"
            },
            "failureReason": {
              "type": "string",
              "enum": [
                "hunk_count_mismatch",
                "git_apply_check_failed",
                "new_file_truncated",
                "gate_failed"
              ]
            }
          },
          "required": [
            "ok",
            "baseRevision",
            "changedPaths",
            "hunkAudit",
            "gitApplyCheckOk",
            "gitApplyCheckStderr",
            "newFileEofOk",
            "newFileEofDetails"
          ]
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "ok"
      ]
    },
    "side_effects": [
      "gate_execution"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.patch.validate.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.patch.validate.result",
        "when": "result"
      },
      {
        "name": "tool.patch.validate.error",
        "when": "error"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
  ({
    "tool_id": "skillset.runtime_summary",
    "description": "Return a non-sensitive snapshot of the current skillset runtime — loaded/rejected ids, exposed tool surface, SOUL budget. No secret, no network, no write.",
    "dispatch_path": {
      "surface": "fetch_path",
      "identifier": "/api/dispatch/skillset/runtime_summary"
    },
    "input_schema": {
      "type": "object",
      "properties": {}
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "schema_version": {
          "type": "string"
        },
        "skillset_ids": {
          "type": "object",
          "properties": {
            "loaded": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "rejected": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "loaded",
            "rejected"
          ]
        },
        "tool_ids": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "total_soul_token_estimate": {
          "type": "integer"
        },
        "per_skillset_token_cap": {
          "type": "integer"
        },
        "total_soul_token_cap": {
          "type": "integer"
        },
        "status": {
          "type": "string"
        }
      },
      "required": [
        "schema_version",
        "skillset_ids",
        "tool_ids",
        "status"
      ]
    },
    "side_effects": [
      "none"
    ],
    "dry_run_supported": false,
    "tier": 2,
    "emit_events": [
      {
        "name": "tool.skillset.runtime_summary.dispatch",
        "when": "dispatch"
      },
      {
        "name": "tool.skillset.runtime_summary.result",
        "when": "result"
      }
    ],
    "required_evidence": [
      {
        "field": "execution.tool_call",
        "required": true
      }
    ],
    "implemented": true
  }) as unknown as ToolContract,
];
