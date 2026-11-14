# testgate registration entry v1

Contract between testgate and the parties that register it into a harness hook configuration. Decided by Shiratsuru (testgate design owner); agreed by Epinel (BellTeam side, bd13). Owner rule: diagrams.product-boundary (#1373) — products connect only through contracted interfaces, drawn in both products' function and data-flow diagrams.

## Registrants

| Registrant | Who | Where it registers |
| --- | --- | --- |
| BellTeam container | Epinel / BellTeam `src/rtk-hooks.mjs` | container harness settings |
| Terminals (rabbit, Mac, fox) | Drilly | terminal harness settings |

## Contract (v1)

1. Register per harness `H` in `{claude, codex, cursor, grok}` the command `node <R>/current/bin/testgate.mjs hook <H>`. Container `R` = `/srv/bellteam/shared/tools/testgate`; terminal `R` = Drilly's install root.
2. The command goes into the ONE PreToolUse item that would otherwise run `rtk hook <H>`. Never register a second item.
3. Presence: if `<R>/current/bin/testgate.mjs` is readable, register (1); otherwise register `rtk hook <H>`.
4. A registrant may swap `rtk hook <H>` and (1) in place, as its own item.
5. Stable under v1: the path, the argv, and the hook I/O (the hook never exits 2; an internal failure is a passthrough). A version switch is a `current` relink only: no re-registration and no Codex re-trust. Changing points 1–4 is v2, announced to the registrants (BellTeam: Epinel; terminals: Drilly) with an overlap period.

## Out of scope

Hook behaviour behind the entry (stage 0/1, shellPlan, adapters) is not part of this contract; see `feature-map.md` and `adapter-contract.md`. The version and distribution procedure stay with Shiratsuru (adoption) and Drilly (terminals).
