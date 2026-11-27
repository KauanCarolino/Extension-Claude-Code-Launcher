# Quota fixtures

`isQuotaError` only treats an output as a quota error when it contains one of these texts in full. Spacing, letter case and the apostrophe style (`'` or `’`) don't matter.

- `fake.txt` is the text the fake provider returns in tests. It is synthetic.
- `claude/*.txt` and `codex/*.txt` hold one message each. Each file is only the fixed start of the message. The reset time and plan links that follow it change from account to account, so they are left out.

## Where each text comes from

None of these has been captured from a real run yet. Each one was copied from the text the CLI itself prints:

- `claude/`: the strings of the Claude Code 2.1.331 binary. It builds the line as `You've hit your <limit>`, followed by details such as `· resets 3pm`. The limit names are `5-hour limit`, `session limit`, `weekly limit`, `Opus limit`, `Sonnet limit`, `Fable limit` and `usage credit limit`. The binary also has `You've hit your monthly spend limit` and `You're out of usage credits`.
- `codex/`: the `Display` texts in `codex-rs/protocol/src/error.rs` of `openai/codex` (`UsageLimitReachedError` and `CodexErrorDetails::QuotaExceeded`). Codex writes the apostrophe as `’`.

When a limit hits for real, compare the raw output saved in `.orquestra/jobs/<id>.runs/` with these files. If the text differs, add the captured message here. Strip personal data such as account emails and reset timestamps tied to the account, then add a test that feeds the block to the adapter's `isQuotaError`.

## What is left out on purpose

- Capacity and overload errors, such as `Selected model is at capacity` or `rate limit exceeded`. They pass on their own, so they count as task failures and stay on the same model.
- Generic words such as `limit` or `429`. A misclassified bug would make the orchestrator spend the other model on it.
