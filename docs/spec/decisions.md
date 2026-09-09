## Decisions

Structural decisions and their reasoning. These grow; a resolved position may appear as an argument under a later issue.

**This section is the spec's tombstone.** Entries removed from the normative sections — invariants, rules, columns, events, whole sections — are recorded here with their rationale, and their numbers are retired, never re-used. The normative prose (§1–§12, §14) describes the current design only; dismissed alternatives are documented here, cited from the prose only where a current rule's rationale requires it.

### Format rules

Each Issue-Based Information System (IBIS) diagram is a **DECISION record for one issue**, maintained as a Mermaid graph. The issue is the scope: if a question splits into genuinely distinct questions, the old issue stays and a new one opens; if a question gets a better answer, the old position is rejected within the same issue.

| #          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IBIS-1** | An IBIS is bounded by its **issue**. Position and argument numbering are unique within the issue only — P009 in one issue and P009 in another are unrelated nodes, and that's fine. An issue is closed only when the question is definitively settled and will not be reopened.                                                                                                                                                                                                                                               |
| **IBIS-2** | Every node carries a **rev tag** (`Rev N.N`) in its text — the revision where it was added. The tag is precise, not a placeholder: `Rev 8.6` is known; `Rev ?.?` is a drafting artifact and must be resolved before merging.                                                                                                                                                                                                                                                                                                  |
| **IBIS-3** | Positions and arguments have the same box shape. A position is just an argument that has been promoted (or demoted) by edges; the difference is the **badge** (`ACCEPTED`, `REJECTED`, or none) inside its text.                                                                                                                                                                                                                                                                                                              |
| **IBIS-4** | **Every edge is labeled `+` or `-`** — a pro or con for the head position. An argument that is a cost in one issue and a benefit in another keeps its intrinsic tag; the edge from its parent says which way it cuts.                                                                                                                                                                                                                                                                                                         |
| **IBIS-5** | **A `wins over` edge encodes supersession.** The newer position points to the older with the label `wins over`; the older's badge flips from `ACCEPTED` to `REJECTED`. The badge alone is not sufficient — the edge is what makes the history navigable and the tombstone's rules enforce that.                                                                                                                                                                                                                               |
| **IBIS-6** | **Positions may carry a cost or benefit tag** following the rev-tag line, e.g. `(Rev 8.6 - cost )` — used only where the position's value is intrinsic to the position on its own. Only the edge label carries the parent's valuation.                                                                                                                                                                                                                                                                                        |
| **IBIS-7** | **Link IDs are typed prefixes + a 3-digit suffix, chosen once per edge, never re-used within an issue:** `pro` (pro — label `+`, thin arrow `-->`), `con` (con — label `-`, dotted arrow `-.->`), `win` (supersession — plain arrow `-->`, the relation is the label, no `+`/`-`), and `ip` (issue → a position — thick arrow `==>`, the billboard edge). Animation, if used, follows the ACCEPTED position's chain: from the issue down `win` edges to the ACCEPTED position, and from there down its `pro` and `con` edges. |
| **IBIS-8** | **`thus` edges** connect an argument or position to a consequence node (text), using the long-dash arrow `--->` (sinks to the bottom, distinct from pro/con). The connection style is uniform: `--->` only. The `thus` set is the **minimal jointly necessary and sufficient conditions for the consequence** — if one edge suffices, there is one; no consequence has two `thus` parents. If the accepted position changes, its no-longer-valid `thus` connections are removed.                                              |

**Maintenance.** A new revision that changes a decision's answer edits the IBIS: the old position is rejected with a `wins over` edge to the new one, and new arguments are appended as nodes. A wholly new issue opens a new IBIS. The graph is the record; the text beneath it (if any) is commentary, not normative. Previous decisions will be brought inline with this new modeling format when they are touched.

### Mermaid decision diagram styling

This mermaid snippet is used to style the decision diagrams consistently.

```mermaid
  classDef issue fill:#2d3748,stroke:#4a5568,color:#fff
  classDef rejected fill:#f00,stroke:#f33,color:#fff
  classDef accepted fill:#0f0,stroke:#3f3,color:#fff
  classDef argument fill:#2c5282,stroke:#2b6cb0,color:#fff
  classDef consequence fill:#2d3748,stroke:#4a5568,color:#fff
  classDef linkPro stroke:#3f3
  classDef linkCon stroke:#f33
```

Edges to and from the ACCEPTED position are animated: `edgeName@{ animate: true }`.

### Persistence database naming (Rev 0.1)

```mermaid
flowchart TD
  I001{{"(Rev 0.1)<br/>Issue: How does the persistence database<br/>name scope itself to its vault?"}}

  I001 ip001@==> P001(["REJECTED<br/>(Rev 0.1)<br/>Derived path-hash address plus persisted<br/>vault-instance identity verification"])
  I001 ip002@==> P002(["ACCEPTED<br/>(Rev 0.1)<br/>Vault scope is Obsidian's per-vault appId;<br/>fallback sha256-hex-12 of the vault path;<br/>no content verification"])

  P002 win001@-- "wins over" --> P001

  P001 pro001@-- "+" --> P003["(Rev 0.1 - benefit)<br/>Documented APIs only:<br/>getBasePath(), randomUUID()"]
  P001 pro002@-- "+" --> P004["(Rev 0.1 - benefit)<br/>Detects distinct vault instances<br/>reusing one filesystem path"]
  P001 con001@-. "-" .-> P005["(Rev 0.1 - cost)<br/>Two extra modules: identity record,<br/>decision table, crash-consistency<br/>ordering, delete latch + Notice"]
  P001 con002@-. "-" .-> P006["(Rev 0.1 - cost)<br/>A data.json field and every failure<br/>mode maintained and tested —<br/>for rebuildable cache"]

  P002 pro003@-- "+" --> P007["(Rev 0.1 - benefit)<br/>appId is Obsidian's own vault-instance id:<br/>stable across restarts and plugin<br/>reinstall, machine-local"]
  P002 pro004@-- "+" --> P008["(Rev 0.1 - benefit)<br/>Obsidian itself namespaces per-vault<br/>storage by appId — precedent, and the<br/>pluginId/databaseId prefix avoids collision"]
  P002 pro005@-- "+" --> P009["(Rev 0.1 - benefit)<br/>Address and identity collapse into one<br/>derivable name: bootstrap reduces to open"]
  P002 con003@-. "-" .-> P010["(Rev 0.1 - cost)<br/>Relies on undocumented app.appId —<br/>mitigated by validation + path-hash fallback"]
  P002 con004@-. "-" .-> P011["(Rev 0.1 - cost)<br/>Fallback scopes by path only: successive<br/>vaults at one path share a database —<br/>accepted, cache is rebuildable"]

  P009 thus001@---> C001("database-identity.ts and database-bootstrap.ts<br/>retired; vaultInstanceId leaves data.json<br/>and the Dexie schema")
  P002 thus002@---> C002("legacy rhizome/cache/path-hash databases<br/>never migrated or auto-deleted — orphaned<br/>under appId scoping, reused on sight under<br/>the identical path-hash fallback")

  classDef issue fill:#2d3748,stroke:#4a5568,color:#fff
  classDef rejected fill:#f00,stroke:#f33,color:#fff
  classDef accepted fill:#0f0,stroke:#3f3,color:#fff
  classDef argument fill:#2c5282,stroke:#2b6cb0,color:#fff
  classDef consequence fill:#2d3748,stroke:#4a5568,color:#fff
  classDef linkPro stroke:#3f3
  classDef linkCon stroke:#f33
  class I001 issue
  class P001 rejected
  class P002 accepted
  class P003,P004,P005,P006,P007,P008,P009,P010,P011 argument
  class C001,C002 consequence
  class pro001,pro002,pro003,pro004,pro005 linkPro
  class con001,con002,con003,con004 linkCon

  ip002@{ animate: true }
  pro003@{ animate: true }
  pro004@{ animate: true }
  pro005@{ animate: true }
  con003@{ animate: true }
  con004@{ animate: true }
  thus001@{ animate: true }
  thus002@{ animate: true }
```

### Platform support (Rev 0.1)

```mermaid
flowchart TD
  I002{{"(Rev 0.1)<br/>Issue: Which platforms does Rhizome support?"}}

  I002 ip001@==> P001(["REJECTED<br/>(Rev 0.1)<br/>Desktop-only: isDesktopOnly manifest flag,<br/>Node/Electron APIs allowed"])
  I002 ip002@==> P002(["ACCEPTED<br/>(Rev 0.1)<br/>Desktop + mobile: src/** restricted<br/>to Web APIs"])

  P002 win001@-- "wins over" --> P001

  P001 pro001@-- "+" --> P003["(Rev 0.1 - benefit)<br/>Node/Electron convenience:<br/>sync node:crypto, fs"]
  P001 con001@-. "-" .-> P004["(Rev 0.1 - cost)<br/>Excludes every mobile user —<br/>fatal for a Dataview replacement"]

  P002 pro002@-- "+" --> P005["(Rev 0.1 - benefit)<br/>Dataview-replacement parity:<br/>Dataview runs on mobile, so must Rhizome"]
  P002 pro003@-- "+" --> P006["(Rev 0.1 - benefit)<br/>Web APIs cover both platforms with no<br/>conditional paths: crypto.subtle, IndexedDB"]
  P002 con002@-. "-" .-> P007["(Rev 0.1 - cost)<br/>No mobile test device or CI —<br/>mitigated by fallback + Web-API-only rule"]
  P002 con003@-. "-" .-> P008["(Rev 0.1 - cost)<br/>Hash derivation becomes async<br/>(crypto.subtle vs sync node:crypto)"]

  P002 thus001@---> C001("desktop-only language removed from AGENTS.md,<br/>docs, and code comments; manifest ships<br/>without isDesktopOnly")
  P006 thus002@---> C002("eslint no-restricted-imports bans<br/>node:* under src/**")

  classDef issue fill:#2d3748,stroke:#4a5568,color:#fff
  classDef rejected fill:#f00,stroke:#f33,color:#fff
  classDef accepted fill:#0f0,stroke:#3f3,color:#fff
  classDef argument fill:#2c5282,stroke:#2b6cb0,color:#fff
  classDef consequence fill:#2d3748,stroke:#4a5568,color:#fff
  classDef linkPro stroke:#3f3
  classDef linkCon stroke:#f33
  class I002 issue
  class P001 rejected
  class P002 accepted
  class P003,P004,P005,P006,P007,P008 argument
  class C001,C002 consequence
  class pro001,pro002,pro003 linkPro
  class con001,con002,con003 linkCon

  ip002@{ animate: true }
  pro002@{ animate: true }
  pro003@{ animate: true }
  con002@{ animate: true }
  con003@{ animate: true }
  thus001@{ animate: true }
  thus002@{ animate: true }
```
