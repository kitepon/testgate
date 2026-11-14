# testgate registration entry v1

Contract between testgate and the parties that register it into a harness hook configuration. Decided by Shiratsuru (testgate design owner); agreed by Epinel (BellTeam side, bd13). Owner rule: diagrams.product-boundary (#1373) — products connect only through contracted interfaces, drawn in both products' function and data-flow diagrams.

## Registrants

| Registrant | Who | Where it registers |
| --- | --- | --- |
| BellTeam container | Drilly publishes RTK's `/srv/bellteam/shared/tools/rtk/harness-entries.json` (`bellteam.harness-entries.v1`); BellTeam reads it as the single writer of each CLI file (BellTeam PR #1396, Epinel) | container harness settings |
| Terminals (rabbit, Mac, fox) | Drilly | terminal harness settings |

The item in that file is exactly point 1's command, so RTK consumes this contract; testgate publishes no file of its own (one hook, one publisher). Any new testgate hook command or event (for example a PostToolUse) goes to Drilly, who changes RTK's file.

## Contract (v1)

1. Register per harness `H` in `{claude, codex, cursor, grok}` the command `node <R>/current/bin/testgate.mjs hook <H>`. Container `R` = `/srv/bellteam/shared/tools/testgate`; terminal `R` = Drilly's install root.
2. The command goes into the ONE PreToolUse item that would otherwise run `rtk hook <H>`. Never register a second item.
3. Presence: if `<R>/current/bin/testgate.mjs` is readable, register (1); otherwise register `rtk hook <H>`.
4. A registrant may swap `rtk hook <H>` and (1) in place, as its own item.
5. Stable under v1: the path, the argv, and the hook I/O (the hook never exits 2; an internal failure is a passthrough). A version switch is a `current` relink only: no re-registration and no Codex re-trust. Changing points 1–4 is v2, announced to the registrants (BellTeam: Epinel; terminals: Drilly) with an overlap period.

## Out of scope

Hook behaviour behind the entry (stage 0/1, shellPlan, adapters) is not part of this contract; see `feature-map.md` and `adapter-contract.md`. The version and distribution procedure stay with Shiratsuru (adoption) and Drilly (terminals).
