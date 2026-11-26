# Quota fixtures

`isQuotaError` only treats an output as a quota error when it contains one of these texts in full. Spacing and letter case don't matter.

- `fake.txt` is the text the fake provider returns in tests. It is synthetic.
- `claude/*.txt` and `codex/*.txt` hold messages captured from real runs of each CLI, one per file. Both folders start empty, so no real error counts as quota yet. Phase 3 adds them.

To capture one, save the exact stderr/stdout block the CLI printed when the limit hit. Strip personal data such as account emails and reset timestamps tied to the account. Then add a test that feeds the block to the adapter's `isQuotaError`.

Never add a generic word such as `limit` or `429`. A misclassified bug would make the orchestrator spend the other model on it.
