# Fake hub

An in-memory stand-in for the Baziness platform API, used by every SDK's tests so they all agree
on one behaviour. It implements the contract the SDKs are written against, including the parts
that are easy to get wrong: refresh-token rotation (`refresh_token_rotated` within 30 s, `reused`
after), one-time link codes that join two games' users into one account, `add-coin` idempotency
(`400 add resource failed`, the answer carries the amount credited), server-only event names refused
on the device path, and players of another game refused one by one.

```bash
node fake-hub.mjs 0     # prints "fake-hub listening on <port>"; API under /api
```

Synthetic test clients: id `12` / secret `fake-client-secret-12`, id `13` / secret
`fake-client-secret-13`. These values work only in this in-memory fake.

Test control (no auth):

| Route | Does |
| --- | --- |
| `POST /__control/reset` | forget everything |
| `POST /__control/fail` `{ path, status, times }` | answer the next `times` calls to `path` with `status` (`0` = drop the connection) |
| `POST /__control/expire-client-tokens` | every client token becomes invalid (the next call gets 401) |
| `POST /__control/link-code` `{ userId }` | a link code, as the Baziness app makes when it opens a game |
| `POST /__control/phone-login` `{ userId }` | the player signs in with a phone |
| `POST /__control/suspend` `{ userId }` | the account is blocked |
| `GET /__control/state` | users, coins, purchases, server and device events, requests |

When the real API changes, change this fake in the same commit as the SDKs.
