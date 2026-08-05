# AI Reviewer host boundary

## Module boundary

Product logic stays under `services/web/modules/ai-reviewer/`. Core changes are
limited to explicit host registrations and non-secret availability state.

| Concern          | Host extension point                                                      | Module rule                                                                                          |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Backend loading  | `config/settings.defaults.js` and `app/src/infrastructure/Modules.mjs`    | Omit the module from `moduleImportSequence` while disabled.                                          |
| Backend routes   | A module router's `apply` method                                          | Guard each Express router instance because core applies module routers three times.                  |
| Integrations     | `overleafModuleImports.integrationPanelComponents`                        | Register a small shell; lazy-load provider settings.                                                 |
| Editor workspace | `overleafModuleImports.railEntries`                                       | Register a small rail entry; lazy-load review and diff UI.                                           |
| Inline findings  | `overleafModuleImports.sourceEditorExtensions`                            | Keep an inert extension while disabled and store AI decorations separately from compile annotations. |
| Editor access    | `EditorViewContext`, `EditorSelectionContext`, and `EditorManagerContext` | Read the active document through existing contexts.                                                  |
| Accepted edits   | CodeMirror `view.dispatch` and the existing realtime extension            | Revalidate first, then use one normal history-bearing transaction.                                   |
| Project reads    | `ProjectGetter`, `ProjectEntityHandler`, and `DocumentUpdater`            | Expose bounded, authenticated, project-relative read tools only.                                     |
| Compile evidence | Parsed frontend compile log entries                                       | Send only bounded diagnostics and revalidate every file/range.                                       |
| Zotero           | Existing Zotero module and linked-file metadata                           | Reuse server-side credentials; treat linked bibliographies as managed and read-only.                 |

## Phase 0 data flow

```text
synthetic AgentRequest
        |
        v
AgentRequestSchema
        |
        v
ScriptedFakeAgentGateway
        |
        v
AgentEventSchema
        |
        +--> FindingSchema --> evidence anchors
        |
        +--> SuggestionSchema --> read-only proposal
```

No Phase 0 path writes a document. Suggestions carry project, document, path,
base revision, base hash, range, original text, replacement text, rationale,
evidence, provider, model, skill, creation time, and status.

## Mutation boundary

Later acceptance must synchronously revalidate:

1. project, document, and path identity;
2. live document revision and text hash;
3. the proposed range and its original text;
4. permissions, connection state, and editor read-only state.

Only a passing proposal may enter a CodeMirror transaction. The backend never
receives an unguarded document-write tool, and AI suggestions are not persisted
as synthetic track changes.

## Loading boundary

Backend feature-off mode omits the module import entirely. Frontend entries
added in Phase 1 remain thin compile-time shells, with review workspace, diff
rendering, and provider code behind dynamic imports. Ordinary typing must not
start a project scan or provider request.
