Turn Recovery lets you customize how BB responds to structured provider errors. Safe built-in defaults continue transient connection/stream failures, retry provider overloads with backoff, and retry subscription-window rate limits after a reported reset. Other categories are ignored unless configured.

Each built-in category can be overridden with a visual editor. You can also create custom rules matching one or more structured fields: error category, provider error code, and HTTP status. A rule has its own action, retry count (including unlimited), initial delay, backoff multiplier, and random jitter. Custom rules are checked before category policies.

Continue retries only the request that just failed, by request ID, and sends no extra user message. BB's `turn.failed` event does not include arbitrary raw error text; custom rules therefore match structured fields, not free-form message phrases.
