# Privacy, reliability and interface review

Observed 2026-09-30. Status: implemented and locally tested; not tested in a live Google deployment. No certification, production-readiness, zero-vulnerability or zero-bug claim is made.

## Implemented changes

| Risk before this change | Severity | Change | Current evidence |
|---|---|---|---|
| A lifecycle operation could commit before failing, then return to PENDING and execute again | High integrity risk | Once execution starts, failures enter RECONCILIATION_REQUIRED. Approval cannot retry that request. A post-commit audit failure is reported separately | Node fault and retry tests |
| Installer retries could create another system; automatic cleanup could trash a possibly deployed Master | High availability risk | Private per-user checkpoints precede creation operations. Completed installs return the existing receipt; content PUT can resume. Ambiguous creation stops for owner reconciliation and preserves resources | Six VM execution/fault tests; actual Google API behavior untested |
| Security records could exhaust Script Properties and prevent authentication | Medium availability risk | UTF-8 admission limits, reserved storage headroom and expired-record reclamation under the shared lock; unexpired grants and unrelated secrets are preserved | Five storage-capacity tests with full local adapters |
| Late task/catalog responses could replace the selected workspace's data | Medium integrity risk | Explicit captured workspace/project and stale-response rejection; replaced-session reads are discarded | Chromium delayed-response tests |
| Repeated concurrent reads caused redundant Google calls | Performance concern | Identical in-flight reads share one request, scoped by token, workspace, action and payload; returned data is cloned. Reads are not retained after completion; writes are not shared or automatically retried | Two identical reads produce one mocked transport call; the next read makes a fresh call |
| Privacy requests and organizational evidence had no dedicated review workflow | Governance gap | Subject-scoped request registry, calendar-month response dates, replay protection, optimistic review versions, privacy notice configuration and seven control-evidence categories | Subject-isolation, pagination, validation, formula escaping, deadline and dispatcher authorization tests |
| Setup screens asserted Google authorization, storage and backup health without testing them | Low misleading-status risk | Replace hard-coded success assertions with explicit verification instructions | Shared-source review and generated build checks |
| External fonts added third-party requests and closed help remained keyboard-accessible | Low privacy/accessibility risk | System fonts; skip link, focus indicators, quick navigation, modal focus trap/inert background, Escape/return focus, hidden help, reduced motion and narrow-screen layout | Browser request, keyboard and 390px layout tests |

Google primary identity and mandatory app TOTP MFA remain the authentication model selected by the user. New privacy/assurance endpoints pass through the existing default-deny session/role matrix. Enrollment-only sessions cannot use them. Root mutations require fresh step-up and a successful pre-mutation audit record. Privacy details, notice content and evidence URLs are not copied into their new audit events.

The privacy review workflow records human decisions. It does not automatically export all personal data, erase data, enforce a legal hold, notify a requester, send email, verify an evidence link or certify a control. Closing a request is an operator attestation that the applicable work and response have been performed through approved channels. Audit-write failure after a saved record remains visible to the operator.

## Validation observed in this turn

- Windows, Node 24.16.0, Python 3.14 and Chromium 153 through Playwright 1.63.0.
- `npm test`: 297 passed, zero failed, including generated-source checks, cryptographic source integrity, authorization/session/MFA, timers, timesheets, reports, request workflows, installer recovery and privacy operations. Google services are represented by adapters.
- Full Chromium suite: 19 workflows. Google identity/MFA transport is mocked; the browser executes the actual generated portal HTML. Check the final GitHub run for the exact branch SHA and outcome.
- `npm audit --json` and `npm audit --omit=dev --json`: zero known advisory findings on 2026-09-30. This checks locked package metadata, not every vulnerability in vendored code or the application.
- Existing service-call budgets passed: master-row lookup and workspace-access lookup avoid full-table reads, and their measured call counts stay the same at 10 versus 50,000 rows in local adapters.
- `node scripts/measure-ui.cjs`: see [measured sizes](UI_SIZE_EVIDENCE.json). Gzipped employee HTML increased from 37,056 to 42,333 bytes; Admin from 36,026 to 41,401; Super Admin from 35,921 to 41,380. These are locally computed compression sizes, not measured Google wire payloads. New controls have a size cost; external font links are zero. No overall live speedup is claimed.
- Accessibility skill scanner: 37 static findings. Three serious flags are false positives in this source: an existing skip link, `background-image: none`, and a single labeled Billable checkbox treated as a group. Thirty-four inline-color warnings need state-by-state contrast review; the scanner does not resolve inherited backgrounds. The muted-text palette measured 6.55:1 on cards. Keyboard/mobile checks are partial accessibility evidence, not a WCAG conformance assessment. The installed scanner's CLI differs from its skill examples; its supported arguments were used.
- `git diff --check`: no whitespace errors. The public patch excludes staging backups, private Google properties and screenshots containing account/deployment details.

## Required live Google release checks

Use only the supplied isolated staging project and disposable private Master Sheet. Update the five runtime files from the reviewed source, preserve existing bootstrap bindings/secrets, verify saved contents, then create a domain-only execute-as-owner deployment after access approval. Record the source SHA, deployment version, account/role, exact result and UTC time for every check.

1. **Owner bootstrap and identity.** Verify the actual active/deployer identities, unauthorized owner denial, single root creation under simultaneous setup attempts and no new public bootstrap endpoint. Verify unknown, duplicated, inactive and out-of-domain identities fail closed.
2. **Google + app MFA.** In separate employee, manager and owner sessions, verify initial enrollment, cancellation/sign-out, wrong/expired/replayed codes, changed Google identity during challenge, session rotation and fresh-code step-up. Have the user enter their own live authenticator credentials. Document root recovery using a protected owner procedure; do not remove MFA as an informal workaround.
3. **Cross-user isolation.** Test foreign workspace IDs, user IDs, request IDs, report scopes and snapshots by calling the real endpoint directly. Regular users and managers must see only their own privacy requests. Only root may review the global queue or evidence registry. Check direct Sheet, Drive, backup and script sharing separately; editors of these resources bypass application RBAC.
4. **Privacy registry.** Initialize the two additive tabs, save an operator-approved notice, submit each right, retry the same operation ID, test the Sheets apostrophe round trip, page more than 200 rows, reject stale versions and keep audit failures visible. Inspect audit records for minimized personal data. Confirm private evidence documents have appropriate sharing.
5. **Timers and approvals.** Exercise start/stop retries, simultaneous requests, reload/workspace switching, timer sweep triggers, stale projects, clock/date/timezone transitions, timesheet snapshot integrity, approval/rejection/reopening and report totals with actual Sheets. Preserve the current start-date attribution until multi-day allocation is deliberately designed and tested. Do not enable multi-day payroll use on the assumption that duration is split by calendar date.
6. **Uncertain lifecycle outcomes.** Inject response loss after user provisioning, deactivation and status updates. Confirm that an uncertain request cannot execute twice. Reconcile the actual account, ACL, member state and logs before any replacement request; record the owner decision.
7. **Installer recovery.** Install with a fresh authorized test user, repeat a completed install, fail/resume content PUT and interrupt each creation stage. Verify Google accepts the reduced installer scopes. Never automatically reset a pending checkpoint. Inspect Google resources and permissions before recording known IDs or deliberately removing unused test resources.
8. **Backup/recovery.** Create, validate and restore a real Drive backup into an isolated copy; verify row counts, IDs, timezone/rates, rollups, MFA-key availability and audit checkpoints. Inject denied Drive access and partial restore. Establish measured RPO/RTO and demonstrate that pointers are changed only after the restored data is validated.
9. **Capacity and performance.** Measure representative real datasets and user concurrency, including sign-in property admission, expired-state cleanup, trigger ownership, request p50/p95, Sheets calls, lock wait, errors and execution time. Compare the same workflows with the baseline under the same conditions. Do not infer Google latency or quota behavior from mocks. Google publishes execution, concurrency and property-storage limits: [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas). Reducing service calls and batching are documented practices: [Google guidance](https://developers.google.com/apps-script/guides/support/best-practices).
10. **Release decision.** Re-run tests affected by any repair, collect independent review and record unresolved risks. Promote only after target-environment evidence is reviewed. Neither a green CI run nor this document proves the absence of vulnerabilities.

## GDPR readiness work owned by the organization

App code supports a workflow; compliance depends on how the organization processes data. The calendar-month initial response target follows [EDPB rights guidance](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en). Its primary search result was retrieved on 2026-09-30; direct-page/PDF retrieval was rate-limited (HTTP 429), so no claim of a fresh full legal review is made.

| Required decision/evidence | Owner | Completion evidence |
|---|---|---|
| Controller identity, jurisdiction, privacy contact and approved notice | Organization/privacy adviser | Published notice available before data collection, configured contact and version |
| Purpose, lawful basis and employee-monitoring proportionality | Privacy/legal + HR | Approved processing register, lawful-basis assessment and DPIA decision where applicable |
| Google processor terms, subprocessors and international transfers | Legal/vendor owner | Current contracts, transfer assessment and selected Google service settings |
| Retention by data category and applicable payroll/legal obligations | Legal + finance + IT | Approved schedule covering Sheets, logs, exports, backups and copies; tested expiry procedure |
| Access, correction, portability, objection, restriction and erasure | Privacy owner | Identity checks, complete data inventory, secure response delivery and tested fulfillment including backups/legal holds; decision records |
| Breach assessment and communication | Incident/privacy owner | Rehearsed incident procedure and jurisdiction-appropriate deadlines; escalation contacts |
| Google identity security and privileged access | IT owner | Enforced Workspace controls, owner recovery, periodic reviews, offboarding and private storage sharing |

Do not invent a retention period or delete payroll records before these decisions. Requests from former employees or people without app access need an external privacy contact/channel. No automatic certification or GDPR approval is implied by the registry.

## SOC 2 assurance preparation

SOC 2 is an examination and assurance report provided by qualified CPAs, not a badge that source code can award. [AICPA's SOC explanation](https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services) was read live on 2026-09-30.

1. Select the service boundary, applicable Trust Services Criteria, report type and independent CPA firm. Agree the system description and evidence period with that firm.
2. Assign owners and approve policies for access reviews, change management, incident response, vendor risk, retention, continuity and security training.
3. Populate the app's seven evidence categories with private, real operating evidence and review dates. MISSING_EVIDENCE, REVIEW_OVERDUE and RECORDED_UNVERIFIED describe records, never an auditor opinion.
4. Collect actual joiner/mover/leaver reviews, MFA settings, reviewed releases and test results, incident exercises, restore drills, vendor reviews and privacy fulfillment records. Retain evidence in access-controlled storage outside ordinary employee access.
5. Conduct a readiness review, remediate exceptions and let the CPA evaluate design and, for the relevant report type, operating effectiveness over the agreed period. A Google SOC report is vendor evidence, not an examination of this app's organization.

## Current blockers and limits

The inspected Google staging tab still shows the prepared New deployment dialog for the earlier runtime. Deployment/OAuth access approval remains pending. This patch has not been deployed, and no live application test has been executed in this turn. The source review and local checks do not establish Google identity behavior, live locks, quotas, sharing, backup restore, production latency, multi-day payroll correctness or certification. Organizational decisions/evidence and independent assessment remain outstanding.
