# Invoice lifecycle

Lifecycle is an explicit state machine; no free-text status mutation is allowed. Events retain occurrence/recording times, source, correlation, causation, regulatory code, full payload hash and evidence-chain hash.

`PAID` emits the French regulatory status code `212` for encaissement simulation. A direct `RECEIVED → PAID` transition is rejected as out of order.
