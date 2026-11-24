# Index and artifact files

Built: a rebuildable SQLite `index.db` (cache format 11, written through `rusqlite` in small transactions and safe for several host processes at once), checked target occurrence lookups, lazily regenerated artifact files with checked outbound-link evidence, and `brauser reindex`.

Pointer: DESIGN.md §5.5, §6.7
