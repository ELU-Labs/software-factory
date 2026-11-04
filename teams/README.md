# teams/

Software factory state: one folder per team. Each holds `team.md` (charter and config), `decisions.md` (append-only), `threads/`, `comms/` (one immutable file per message), `tasks/`, `issues/`, `reports/` and `metrics.jsonl`.

This folder is gitignored apart from this README and `.gitignore`: factory state stays on this machine and is never committed. It has no Git history, so `git clean -x` deletes it.

Change it only through the CLI; the contract is in [factory/PROTOCOL.md](../factory/PROTOCOL.md). The one part edited by hand is the charter sections of each `team.md` (Mission, Scope, Out of scope, Working agreements), by the owner or the team lead; its config changes with `team edit`. Run `validate` after a charter edit.

```bash
node factory/bin/factory.mjs team new checkout --title "Checkout" --as you
node factory/bin/factory.mjs team edit checkout --data-source "feedback=support tickets tagged checkout" --repo-paths app/checkout --as you
node factory/bin/factory.mjs thread new checkout/checkout-v2 --title "Checkout v2" --as fable
node factory/bin/factory.mjs inbox --as fable
node factory/bin/factory.mjs validate
node factory/bin/factory.mjs ui            # the board, at http://127.0.0.1:4477
```
