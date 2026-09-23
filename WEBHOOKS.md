# Webhooks

Business Suite compatibility uses `POST /inbound/invoices` and HMAC SHA-256 over the exact raw body. Supported metadata headers are `X-Filename`, `X-Source-Name`, `X-Message-Id` and `X-Conversation-Id`.

The cryptographic primitive is implemented and tested. Delivery subscriptions, queues, retries and history are scheduled for increment 2.
