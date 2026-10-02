# Turn Recovery

Turn Recovery applies configurable recovery actions to newly failed turns. It reads BB's retained thread events and associates the original `provider/error` message with the specific failed request ID, so custom text rules do not accidentally match stale errors earlier in the conversation.

## Built-in behavior

- Connection failures, stream disconnections, and policy errors continue the failed turn without adding a user-visible message.
- Default custom rules continue messages containing `Upstream HTTP/2 stream failed`, `Upstream response stream was interrupted`, and `Invalid prompt:`.
- Provider overloads retry with exponential backoff and jitter.
- Rate limits retry only when BB reports a blocked subscription window with a reset time; retries are scheduled at or after that reset.
- Other categories are ignored unless you configure a policy or matching custom rule.

Every recovery is bound to the request ID from its `turn.failed` event. This prevents a retry from targeting an older turn after the thread has moved on.

## Visual configuration

Open the Turn Recovery plugin settings page. Built-in categories can be overridden, and custom rules can match one or more of:

- A substring in the original provider error message (case-insensitive)
- Structured error category
- Provider error code
- HTTP status code

Every condition specified in a rule must match. Rules are checked before category policies. Each rule has an action (`continue`, `retry`, or `ignore`), a retry limit (or unlimited), initial delay, backoff multiplier, and random jitter. You can add, edit, or delete rules in the UI.

For example, create a rule with message contains `Invalid prompt: your prompt was flagged`, action **Continue**, and the desired retry limit. Configure different API providers independently with different message substrings.

Inspect effective policies from the CLI:

```sh
bb turn-recovery policies
bb turn-recovery policies --json
```
