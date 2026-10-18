# 11 Governance - Spec
Prefix: GOV · Milestone: M4 · Status: done

## Goal
Production changes are reviewed by a second person and every action is traceable and exportable.

## Scope
Audit query/export/retention; protected environments with change requests; approvals for sync and IaC apply; audit forwarding.

## Non-goals
Audit *capture* (API-8 does it), SAML/SSO, compliance report templates.

## Design
- Protected environment: flag on `environments`. Variable writes there create a **change request** instead of applying; an approver other than the author applies it (four-eyes). Same mechanism gates sync apply (GOV-3) and IaC apply.
- Change request states: open -> approved -> applied | rejected | expired. Stored diff contains key names and actions, not values; encrypted pending values live in the same envelope scheme.
- Audit read access is its own permission; exports are themselves audited.
- Forwarding uses the POL-2 sink interface, at-least-once, with ordering by event id.

## Acceptance
A developer's change to a production variable waits for a maintainer, applies only after approval, shows in the audit log with both people, and can be forwarded to an external collector.

## Risks / human gates
Approval semantics are security-sensitive: `/security-review`, and confirm the rules (who may approve, expiry) with the user.
