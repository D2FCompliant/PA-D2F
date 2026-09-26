# Fault injection

Fault injection exists only through deterministic `/sandbox/v1/scenarios/{scenarioId}/executions` scenarios. Production connectors cannot import or enable it. External networking remains disabled regardless of a requested fault scenario.

The stable negative library covers invalid XML, XSD/Schematron and business-rule rejection, missing canonical fields, invalid VAT/totals, duplicate invoice/message/submission, all directory failures, PAR/Buyer temporary failure and rejection, lifecycle actor/transition/order/final-state errors, PPF temporary errors and replay. Tests use fixed clocks and explicit outcomes; no unseeded randomness selects a fault.
